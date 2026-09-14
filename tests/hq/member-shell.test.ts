// The member shell stays on the member side. A static scan keeps the member
// layout, the builder components and the two pure modules free of operator
// imports (queries, chrome, session, operator actions), the way the auth
// boundary test keeps every page gated; the render checks cover the captain
// page's gate and the two Connect Telegram hints with the actor stubbed.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemberActor } from "@/lib/hq/actor";

const mocks = vi.hoisted(() => ({
  currentActor: vi.fn(),
  requireMemberActor: vi.fn(),
  teams: vi.fn(),
  hasTeams: vi.fn(),
  currentHackathonId: vi.fn(),
  teamById: vi.fn(),
  leaderboard: vi.fn(),
  listAssignments: vi.fn(),
  builderDatabase: vi.fn(),
  pathname: "/hq/dashboard",
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); },
  usePathname: () => mocks.pathname,
  useRouter: () => ({ replace() {}, refresh() {}, push() {} }),
}));
vi.mock("@/lib/hq/actor", () => ({ currentActor: mocks.currentActor, requireMemberActor: mocks.requireMemberActor }));
vi.mock("@/lib/hq/member-auth", () => ({ currentMember: vi.fn(), requireMember: vi.fn() }));
vi.mock("@/lib/hq/builder-store", () => ({
  builderStore: () => ({
    teams: mocks.teams,
    hasTeams: mocks.hasTeams,
    currentHackathonId: mocks.currentHackathonId,
    teamById: mocks.teamById,
    dashboard: async () => ({ tier: "regular", requests: [], enrollments: [], events: [] }),
    hackathons: async () => [],
  }),
}));
// The captain page's two other reads: a real pool would need DATABASE_URL,
// which this unit test never sets, and the DB-shaped functions themselves
// are stubbed below so nothing here touches a real connection.
vi.mock("@/lib/hq/builder-db", () => ({ builderDatabase: mocks.builderDatabase }));
vi.mock("@/lib/hq/captains", () => ({ leaderboard: mocks.leaderboard, listAssignments: mocks.listAssignments }));
// The icon package ships its source; the pages here render markup, not icons.
vi.mock("symbols-react", () => ({ IconArrowRight: (props: Record<string, unknown>) => createElement("svg", props) }));

import HqMemberLayout from "@/app/hq/(member)/layout";
import CaptainPage from "@/app/hq/(member)/captain/page";
import DashboardPage from "@/app/hq/(member)/dashboard/page";
import { BuilderShell } from "@/components/hq/builder-shell";

const ROOT = process.cwd();

function member(overrides: Partial<MemberActor> = {}): MemberActor {
  return { kind: "member", id: "acct-1", name: "Fictional Builder", email: "builder@example.com", capabilities: new Set(), telegram: null, ...overrides };
}

describe("the member shell imports nothing operator-side", () => {
  // builder-admin.tsx is the operator's panel about builders, rendered by the admin page; it is operator-side by design and forbidden below instead.
  const scanned = [
    "app/hq/(member)/layout.tsx",
    "lib/hq/member-nav.ts",
    "lib/hq/member-routes.ts",
    ...readdirSync(join(ROOT, "components/hq")).filter((name) => name.startsWith("builder-") && name.endsWith(".tsx") && !name.startsWith("builder-admin")).map((name) => `components/hq/${name}`),
  ];
  // Operator-side modules: data, session, chrome, the admin builder panel, and every operator-gated action module (tests/hq/auth-boundary.test.ts holds the gate map).
  const FORBIDDEN = new Set(["lib/hq/queries", "lib/hq/builder-admin-queries", "lib/hq/auth", "lib/hq/session", "lib/hq/hackathon", "lib/hq/db", "lib/hq/authz", "components/hq/chrome", "components/hq/toast", "components/hq/ui", "components/hq/ui-client", "components/hq/admin", "components/hq/builder-admin", "components/hq/dashboard", "components/hq/people", "components/hq/projects", "components/hq/search-modal", "components/hq/activity-drawer", "components/hq/hackathon-switcher"]);
  const MEMBER_ACTIONS = new Set(["lib/hq/actions/builders", "lib/hq/actions/telegram"]);

  /** Every runtime import specifier, resolved to a repo-relative module path; type-only imports are erased and skipped. */
  function runtimeImports(file: string): string[] {
    const source = readFileSync(join(ROOT, file), "utf8");
    const specifiers = [...source.matchAll(/^\s*(?:import|export)\s+(?!type\s)[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]);
    return specifiers.map((specifier) => {
      if (specifier.startsWith("@/")) return specifier.slice(2);
      if (specifier.startsWith(".")) return posix.normalize(posix.join(dirname(file), specifier));
      return specifier;
    }).map((path) => path.replace(/\.(tsx?|css)$/, ""));
  }

  it("scans the layout, the two pure modules and every builder component", () => {
    expect(scanned.length).toBeGreaterThanOrEqual(7);
    expect(scanned).toContain("components/hq/builder-nav.tsx");
    expect(scanned).toContain("components/hq/builder-shell.tsx");
  });

  for (const file of scanned) {
    it(file, () => {
      for (const target of runtimeImports(file)) {
        expect(FORBIDDEN.has(target), `${file} imports ${target}`).toBe(false);
        expect(target.startsWith("app/hq/(app)"), `${file} imports ${target}`).toBe(false);
        if (target.startsWith("lib/hq/actions/")) expect(MEMBER_ACTIONS.has(target), `${file} imports the operator action module ${target}`).toBe(true);
      }
    });
  }

  it("keeps the two pure modules client-safe: no server-only, no environment, no runtime import of a server module", () => {
    for (const file of ["lib/hq/member-nav.ts", "lib/hq/member-routes.ts"]) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source, file).not.toContain("server-only");
      expect(source, file).not.toContain("process.env");
      for (const target of runtimeImports(file)) expect(target.startsWith("lib/hq/"), `${file} imports ${target} at runtime`).toBe(false);
    }
  });

  it("keeps the shell a server component that renders the client nav, and the nav a client component", () => {
    expect(readFileSync(join(ROOT, "components/hq/builder-nav.tsx"), "utf8").startsWith("'use client'")).toBe(true);
    expect(readFileSync(join(ROOT, "components/hq/builder-shell.tsx"), "utf8")).not.toContain("use client");
    expect(readFileSync(join(ROOT, "app/hq/(member)/layout.tsx"), "utf8")).not.toContain("use client");
  });
});

describe("the captain page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The captain-with-nothing-yet defaults every test starts from; tests
    // that need real assignment or leaderboard data override these.
    mocks.currentHackathonId.mockResolvedValue(41);
    mocks.listAssignments.mockResolvedValue([]);
    mocks.leaderboard.mockResolvedValue([]);
    mocks.teamById.mockResolvedValue(null);
    mocks.builderDatabase.mockReturnValue({});
  });

  it("is not found without the capability, whatever else the account holds", async () => {
    mocks.requireMemberActor.mockResolvedValue(member({ telegram: { userId: "7000000000123" } }));
    await expect(CaptainPage()).rejects.toThrow("NOT_FOUND");
    expect(mocks.requireMemberActor).toHaveBeenCalledWith("/hq/captain");
    expect(mocks.listAssignments).not.toHaveBeenCalled();
    expect(mocks.leaderboard).not.toHaveBeenCalled();
  });

  it("sends a signed-out visitor to sign in with the captain URL as the destination", async () => {
    mocks.requireMemberActor.mockImplementation(async (next?: string) => { throw new Error(`REDIRECT:/hq/signin?next=${encodeURIComponent(next ?? "")}`); });
    await expect(CaptainPage()).rejects.toThrow(`REDIRECT:/hq/signin?next=${encodeURIComponent("/hq/captain")}`);
  });

  it("shows the empty state and the Connect Telegram hint for a captain without a Telegram identity", async () => {
    mocks.requireMemberActor.mockResolvedValue(member({ capabilities: new Set(["captain"]) }));
    const html = renderToStaticMarkup(await CaptainPage());
    expect(html).toContain("No assignments yet. Assignments appear here once an admin assigns you a team.");
    expect(html).toContain("Connect Telegram");
    expect(html).toMatch(/<a[^>]*href="\/hq\/account"[^>]*>Connect Telegram<\/a>/);
    expect(html).not.toMatch(/[—·]/);
    expect(html.toLowerCase()).not.toMatch(/operator|hq-chrome/);
  });

  it("drops the hint once Telegram is linked", async () => {
    mocks.requireMemberActor.mockResolvedValue(member({ capabilities: new Set(["captain"]), telegram: { userId: "7000000000123" } }));
    const html = renderToStaticMarkup(await CaptainPage());
    expect(html).toContain("No assignments yet.");
    expect(html).not.toContain("Connect Telegram");
  });

  it("reads the current edition once, and asks its two data reads for exactly the signed-in Captain's own id", async () => {
    mocks.requireMemberActor.mockResolvedValue(member({ capabilities: new Set(["captain"]), telegram: { userId: "7" } }));
    const db = { marker: "builder-pool" };
    mocks.builderDatabase.mockReturnValue(db);
    await CaptainPage();
    expect(mocks.currentHackathonId).toHaveBeenCalledTimes(1);
    expect(mocks.listAssignments).toHaveBeenCalledWith(db, { hackathonId: 41, captainUserId: "acct-1" });
    expect(mocks.leaderboard).toHaveBeenCalledWith(db, 41, "acct-1");
  });

  it("renders the Captain's own assignment and the leaderboard, marking their own row, with no other project's name", async () => {
    mocks.requireMemberActor.mockResolvedValue(member({ capabilities: new Set(["captain"]), telegram: { userId: "7" } }));
    mocks.listAssignments.mockResolvedValue([
      { projectId: "p1", projectName: "Solo Project", hackathonId: 41, captainUserId: "acct-1", captainName: "Fictional Builder", assignedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    mocks.teamById.mockResolvedValue({
      id: "p1", name: "Solo Project", hackathonId: 41, hackathonName: "Edition A",
      projectUrl: "https://colosseum.com/arena/projects/explore/solo", description: "internal only", stage: "mvp",
      verification: "verified", ownerId: "acct-1", leadUsername: "acct1_handle",
      members: [{ id: "m1", name: "Fictional Builder", username: "acct1_handle", avatarUrl: null, joined: true }],
      source: {
        category: null, tracks: [], twitterHandle: null, website: null, repoLink: null,
        presentationLink: null, technicalDemoLink: null, pitchVideoLink: null, demoVideoLink: null,
        imageUrl: null, submissionStatus: "not_checked", submittedAt: null, completion: null,
        sourceStatus: "never", sourceCheckedAt: null, sourceErrorCode: null,
      },
    });
    // Another Captain's name and count are allowed on the leaderboard; their
    // project id, title or link are not part of this shape at all.
    mocks.leaderboard.mockResolvedValue([
      { rank: 1, displayName: "Fictional Builder", assignedCount: 1, isYou: true },
      { rank: 2, displayName: "Other Captain", assignedCount: 0, isYou: false },
    ]);
    const html = renderToStaticMarkup(await CaptainPage());
    expect(html).not.toContain("No assignments yet.");
    expect(html).toContain("Solo Project");
    expect(html).toContain("Other Captain");
    expect(html).toContain("(you)");
    // The description field never reaches a Captain's own copy of their team either.
    expect(html).not.toContain("internal only");
  });
});

describe("the dashboard", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.teams.mockResolvedValue([]); });

  it("offers Connect Telegram to an account without a Telegram identity, pointing at the account page", async () => {
    mocks.requireMemberActor.mockResolvedValue(member());
    const html = renderToStaticMarkup(await DashboardPage());
    expect(html).toContain("Welcome, Fictional Builder.");
    expect(html).toMatch(/<a[^>]*href="\/hq\/account"[^>]*>Connect Telegram<\/a>/);
    // Sign out lives in the shell's account corner now, not in the page body.
    expect(html).not.toContain("Sign out");
    expect(html).not.toMatch(/[—·]/);
  });

  it("shows no such card once Telegram is linked", async () => {
    mocks.requireMemberActor.mockResolvedValue(member({ telegram: { userId: "7000000000123" } }));
    const html = renderToStaticMarkup(await DashboardPage());
    expect(html).not.toContain("Connect Telegram");
  });
});

describe("the member layout", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  const shell = createElement(BuilderShell, null, createElement("p", null, "content"));
  const render = async () => renderToStaticMarkup(await HqMemberLayout({ children: shell }));

  it("derives the menu and the account corner from the actor and the team existence check, for the shell a page renders", async () => {
    mocks.currentActor.mockResolvedValue(member({ capabilities: new Set(["captain"]) }));
    mocks.hasTeams.mockResolvedValue(true);
    mocks.pathname = "/hq/captain";
    const html = await render();
    for (const label of ["Home", "My teams", "Captain", "Connect Telegram", "Account"]) expect(html).toContain(`>${label}</a>`);
    expect(html).toContain("Fictional Builder");
    expect(html).toMatch(/<button[^>]*>Sign out<\/button>/);
    expect(html).toContain("<p>content</p>");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(mocks.hasTeams).toHaveBeenCalledWith("acct-1");
    // The dashboard loads the teams it renders; the menu never loads them to count them.
    expect(mocks.teams).not.toHaveBeenCalled();
  });

  it("offers Register team while the existence check is false", async () => {
    mocks.currentActor.mockResolvedValue(member());
    mocks.hasTeams.mockResolvedValue(false);
    const html = await render();
    expect(html).toContain(">Register team</a>");
    expect(html).not.toContain(">My teams</a>");
  });

  it("renders no menu for a visitor, and none for an operator session, which is not a member", async () => {
    mocks.currentActor.mockResolvedValue(null);
    expect(await render()).not.toContain("HQ navigation");
    mocks.currentActor.mockResolvedValue({ kind: "operator", id: "op", displayName: "Operator" });
    const html = await render();
    expect(html).not.toContain("HQ navigation");
    expect(html).not.toContain("Operator");
    expect(html).not.toContain("Sign out");
    expect(mocks.hasTeams).not.toHaveBeenCalled();
  });
});
