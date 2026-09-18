// The member shell stays on the member side. A static scan keeps the member
// layout, the builder components and the pure route module free of operator
// imports (queries, chrome, session, operator actions), the way the auth
// boundary test keeps every page gated; the render checks cover the captain
// page's gate and the two Connect Telegram hints with the actor stubbed.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemberActor } from "@/lib/hq/actor";

const mocks = vi.hoisted(() => ({
  currentActor: vi.fn(),
  requireMemberActor: vi.fn(),
  teams: vi.fn(),
  ownedProjects: vi.fn(),
  currentHackathonId: vi.fn(),
  teamById: vi.fn(),
  leaderboard: vi.fn(),
  listAssignments: vi.fn(),
  captainReportingBoard: vi.fn(),
  memberWeekSummaries: vi.fn(),
  dashboard: vi.fn(),
  hackathons: vi.fn(),
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
    ownedProjects: mocks.ownedProjects,
    currentHackathonId: mocks.currentHackathonId,
    teamById: mocks.teamById,
    dashboard: mocks.dashboard,
    hackathons: mocks.hackathons,
  }),
}));
// The captain page's two other reads: a real pool would need DATABASE_URL,
// which this unit test never sets, and the DB-shaped functions themselves
// are stubbed below so nothing here touches a real connection.
vi.mock("@/lib/hq/builder-db", () => ({ builderDatabase: mocks.builderDatabase }));
vi.mock("@/lib/hq/captains", () => ({ leaderboard: mocks.leaderboard, listAssignments: mocks.listAssignments }));
// The captain page's reporting half (phase 6). tests/hq/captain-page.test.ts
// drives the same page against real rows; here it is stubbed, like the two
// reads above, so this file stays a unit test of the shell and the gate.
vi.mock("@/lib/hq/reporting-surface", () => ({ captainReportingBoard: mocks.captainReportingBoard, memberWeekSummaries: mocks.memberWeekSummaries }));
// The icon package ships its source; the pages here render markup, not icons.
vi.mock("symbols-react", () => ({
  IconArrowLeft: (props: Record<string, unknown>) => createElement("svg", props),
  IconArrowRight: (props: Record<string, unknown>) => createElement("svg", props),
}));

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
    "lib/hq/member-routes.ts",
    // Phase 6's member reporting interface: a client component of the member
    // shell like the builder-* ones below, and held to the same rule.
    "components/hq/reporting-member.tsx",
    // The entry card the team page and the Captains' Den share.
    "components/hq/reporting-entry-card.tsx",
    ...readdirSync(join(ROOT, "components/hq")).filter((name) => name.startsWith("builder-") && name.endsWith(".tsx") && !name.startsWith("builder-admin")).map((name) => `components/hq/${name}`),
  ];
  // Operator-side modules: data, session, chrome, the admin builder panel, and every operator-gated action module (tests/hq/auth-boundary.test.ts holds the gate map).
  const FORBIDDEN = new Set(["lib/hq/queries", "lib/hq/builder-admin-queries", "lib/hq/auth", "lib/hq/session", "lib/hq/hackathon", "lib/hq/db", "lib/hq/authz", "components/hq/chrome", "components/hq/toast", "components/hq/ui", "components/hq/ui-client", "components/hq/admin", "components/hq/builder-admin", "components/hq/dashboard", "components/hq/people", "components/hq/projects", "components/hq/search-modal", "components/hq/activity-drawer", "components/hq/hackathon-switcher"]);
  const MEMBER_ACTIONS = new Set(["lib/hq/actions/builders", "lib/hq/actions/invite", "lib/hq/actions/reporting", "lib/hq/actions/telegram"]);

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

  it("scans the layout, the pure route module and every builder component", () => {
    expect(scanned.length).toBeGreaterThanOrEqual(8);
    expect(scanned).toContain("components/hq/reporting-member.tsx");
    expect(scanned).toContain("components/hq/builder-account-menu.tsx");
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

  it("keeps the pure route module client-safe: no server-only, no environment, no runtime import of a server module", () => {
    const file = "lib/hq/member-routes.ts";
    const source = readFileSync(join(ROOT, file), "utf8");
    expect(source, file).not.toContain("server-only");
    expect(source, file).not.toContain("process.env");
    for (const target of runtimeImports(file)) expect(target.startsWith("lib/hq/"), `${file} imports ${target} at runtime`).toBe(false);
  });

  it("keeps the shell a server component that renders the client account menu, and the menu a client component", () => {
    expect(readFileSync(join(ROOT, "components/hq/builder-account-menu.tsx"), "utf8").startsWith("'use client'")).toBe(true);
    expect(readFileSync(join(ROOT, "components/hq/builder-shell.tsx"), "utf8")).not.toContain("use client");
    expect(readFileSync(join(ROOT, "app/hq/(member)/layout.tsx"), "utf8")).not.toContain("use client");
  });
});

describe("the captain page", () => {
  const week = { periodId: "week-1", periodSequence: 1, startDate: "2026-09-14", endDate: "2026-09-20", startsAt: "2026-09-13T22:00:00.000Z", endsAt: "2026-09-20T22:00:00.000Z", completed: false };
  // The service row the page orders by and never serializes: it carries the Captain's account id and the eligibility date.
  const status = {
    projectId: "p1", projectName: "Solo Project", hackathonId: 41, imported: true,
    eligibleFrom: "2026-01-01T00:00:00.000Z", paused: false, captainUserId: "acct-1",
    submissionStatus: "not_checked", current: null, missedPeriods: 0, history: [],
  };
  const card = { status, current: week, weeks: [week], teamContact: "@nienkev", entries: [], nextCursor: null, submissionFocus: null };
  const board = (overrides: Record<string, unknown> = {}) => ({ hackathonId: 41, timezone: "Europe/Amsterdam", cards: [], week: null, captainContact: null, ...overrides });
  const team = {
    id: "p1", name: "Solo Project", hackathonId: 41, hackathonName: "Edition A",
    projectUrl: "https://colosseum.com/arena/projects/explore/solo", description: "internal only", stage: "mvp",
    verification: "verified", ownerId: "acct-1", leadUsername: "acct1_handle",
    members: [
      { id: "m1", name: "Fictional Builder", username: "acct1_handle", avatarUrl: null, joined: true },
      { id: "m2", name: "Sofie Jansen", username: "sofiej", avatarUrl: null, joined: false },
    ],
    source: {
      category: null, tracks: [], twitterHandle: null, website: null, repoLink: null,
      presentationLink: null, technicalDemoLink: null, pitchVideoLink: null, demoVideoLink: null,
      imageUrl: null, submissionStatus: "not_checked", submittedAt: null, completion: null,
      sourceStatus: "never", sourceCheckedAt: null, sourceErrorCode: null,
    },
  };
  const captain = () => member({ capabilities: new Set(["captain"]), telegram: { userId: "7" } });
  const render = async () => renderToStaticMarkup(await CaptainPage());

  beforeEach(() => {
    vi.clearAllMocks();
    // The Captain-with-nothing-yet defaults every test starts from; tests
    // that need an assignment override the board.
    mocks.currentHackathonId.mockResolvedValue(41);
    mocks.captainReportingBoard.mockResolvedValue(board());
    mocks.teamById.mockResolvedValue(null);
    mocks.builderDatabase.mockReturnValue({});
  });

  it("is not found without the capability, whatever else the account holds, before any read", async () => {
    mocks.requireMemberActor.mockResolvedValue(member({ telegram: { userId: "7000000000123" } }));
    await expect(CaptainPage()).rejects.toThrow("NOT_FOUND");
    expect(mocks.requireMemberActor).toHaveBeenCalledWith("/hq/captain");
    expect(mocks.captainReportingBoard).not.toHaveBeenCalled();
    expect(mocks.teamById).not.toHaveBeenCalled();
  });

  it("sends a signed-out visitor to sign in with the captain URL as the destination", async () => {
    mocks.requireMemberActor.mockImplementation(async (next?: string) => { throw new Error(`REDIRECT:/hq/login?next=${encodeURIComponent(next ?? "")}`); });
    await expect(CaptainPage()).rejects.toThrow(`REDIRECT:/hq/login?next=${encodeURIComponent("/hq/captain")}`);
  });

  it("renders the empty Den for a Captain with no assignments: the aside, one line in the main column, no hints", async () => {
    mocks.requireMemberActor.mockResolvedValue(member({ capabilities: new Set(["captain"]) }));
    const html = await render();
    expect(html).toContain("Captains&#x27;");
    expect(html).toContain("Your teams");
    expect(html).toContain("Your contact");
    expect(html).toContain("Not shared yet.");
    expect(html).toContain("No teams assigned yet.");
    expect(html).toMatch(/<a[^>]*href="\/hq\/dashboard"[^>]*>(?:(?!<\/a>).)*Home<\/a>/);
    for (const copy of ["No assignments yet", "Connect Telegram", "leaderboard", "Week ", "<textarea"]) expect(html).not.toContain(copy);
    expect(html).not.toMatch(/[—·]/);
    expect(html.toLowerCase()).not.toMatch(/operator|hq-chrome/);
  });

  it("reads the current edition once, and asks the board for exactly the signed-in Captain at one instant", async () => {
    const actor = captain();
    mocks.requireMemberActor.mockResolvedValue(actor);
    const db = { marker: "builder-pool" };
    mocks.builderDatabase.mockReturnValue(db);
    await CaptainPage();
    expect(mocks.currentHackathonId).toHaveBeenCalledTimes(1);
    expect(mocks.captainReportingBoard).toHaveBeenCalledTimes(1);
    expect(mocks.captainReportingBoard).toHaveBeenCalledWith(actor, 41, db, expect.any(Number));
  });

  it("reads no board without a current edition, and still renders the Den", async () => {
    mocks.requireMemberActor.mockResolvedValue(captain());
    mocks.currentHackathonId.mockResolvedValue(null);
    const html = await render();
    expect(mocks.captainReportingBoard).not.toHaveBeenCalled();
    expect(html).toContain("No teams assigned yet.");
  });

  it("renders the Captain's own team: the week, the due line, the builders and their tags, the contact link and the note form, and nothing internal", async () => {
    mocks.requireMemberActor.mockResolvedValue(captain());
    mocks.captainReportingBoard.mockResolvedValue(board({ cards: [card], week: { sequence: 1, total: 4 }, captainContact: "@femkedj" }));
    mocks.teamById.mockResolvedValue(team);
    const html = await render();
    expect(mocks.teamById).toHaveBeenCalledWith("p1");
    // The aside.
    expect(html).toContain("Week 1 of 4");
    expect(html).toContain("@femkedj");
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>(?:(?!<\/button>).)*Solo Project/);
    expect(html).toContain('aria-label="Not updated"');
    expect(html).not.toContain(">Updated</span>");
    // The main column for that team.
    expect(html).toContain("Team not updated. Due Sunday 20 September, 23:59 CEST");
    expect(html).toContain("Fictional Builder");
    expect(html).toContain(">Lead</span>");
    expect(html).toContain("Sofie Jansen");
    expect(html).toContain(">Not joined</span>");
    expect(html).toMatch(/<a[^>]*href="https:\/\/t\.me\/nienkev"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*>@nienkev<\/a>/);
    expect(html).toContain("No update from the team this week.");
    expect(html).toMatch(/<a[^>]*href="https:\/\/colosseum\.com\/arena\/projects\/explore\/solo"[^>]*>View on Colosseum<\/a>/);
    expect(html).toContain(">Your note</p>");
    expect(html).toContain('placeholder="What you saw, what you told them, what to watch."');
    expect(html).toContain('maxLength="4000"');
    expect(html).toContain("Keep private");
    expect(html).toContain("Add note");
    expect(html).toMatch(/<span id="priv-tip" role="tooltip"[^>]*hidden=""[^>]*>Only visible to you and HQ admins<\/span>/);
    expect(html).not.toContain("Earlier");
    // Neither the team's internal description nor the service row's fields reach the markup.
    for (const secret of ["internal only", "acct-1", "2026-01-01", "eligibleFrom", "captainUserId"]) expect(html).not.toContain(secret);
    expect(html).not.toMatch(/[—·]/);
  });

  it("shows a completed week as updated with the note optional, and an earlier private note with its tag and no Edit control", async () => {
    mocks.requireMemberActor.mockResolvedValue(captain());
    const entries = [
      { id: "e1", projectId: "p1", periodId: "week-1", periodSequence: 1, body: "Shipped the QR checkout flow on devnet.", visibility: "shared", source: "hq", version: 1, late: false, edited: false, submittedAt: "2026-09-16T10:00:00.000Z", updatedAt: "2026-09-16T10:00:00.000Z", authorName: "Fictional Builder", authorIsYou: false, canEdit: false, voided: false },
      { id: "e2", projectId: "p1", periodId: "week-1", periodSequence: 1, body: "Team dynamics look healthy.", visibility: "sensitive", source: "hq", version: 1, late: false, edited: false, submittedAt: "2026-09-15T10:00:00.000Z", updatedAt: "2026-09-15T10:00:00.000Z", authorName: "Fictional Captain", authorIsYou: true, canEdit: true, voided: false },
    ];
    mocks.captainReportingBoard.mockResolvedValue(board({ cards: [{ ...card, current: { ...week, completed: true }, entries }], week: { sequence: 1, total: 4 } }));
    mocks.teamById.mockResolvedValue(team);
    const html = await render();
    expect(html).toContain("Team updated this week. No note needed");
    expect(html).toContain(">Updated</span>");
    expect(html).not.toContain('aria-label="Not updated"');
    expect(html).toContain("Your note (optional)");
    expect(html).toContain("Last update: Fictional Builder, 16 September.");
    expect(html).toContain("Earlier");
    expect(html).toContain("Shipped the QR checkout flow on devnet.");
    expect(html).toContain("<span>Fictional Builder, 16 September</span>");
    expect(html).toContain("<span>You, 15 September</span>");
    expect(html).toContain('title="Only visible to you and HQ admins"');
    expect(html.match(/>Private<\/span>/g)).toHaveLength(1);
    expect(html).not.toMatch(/>Edit</);
    expect(html).not.toContain("Show older notes");
    expect(html).not.toMatch(/[—·]/);
  });
});

describe("the dashboard menu", () => {
  const edition = { id: 900001, name: "Worlds Fair", startDate: "2026-09-14", endDate: "2026-10-11", hostingEnabled: false };
  const team = { id: "team-1", name: "Tulip", hackathonId: edition.id, hackathonName: edition.name, verification: "verified" };
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
    mocks.requireMemberActor.mockResolvedValue(member());
    mocks.teams.mockResolvedValue([]);
    mocks.ownedProjects.mockResolvedValue([]);
    mocks.memberWeekSummaries.mockResolvedValue([]);
    mocks.dashboard.mockResolvedValue({ tier: "regular", requests: [], enrollments: [], events: [] });
    mocks.hackathons.mockResolvedValue([edition]);
  });
  afterEach(() => vi.useRealTimers());
  const render = async () => renderToStaticMarkup(await DashboardPage());

  it("renders a menu with the current hackathon and account instead of update details or forms", async () => {
    const html = await render();
    expect(html).toContain("<h1>Home</h1>");
    expect(html).toContain('aria-label="Home menu"');
    expect(html).toContain('href="/hq/hackathon/900001"');
    expect(html).toContain("Worlds Fair");
    expect(html).toContain('href="/hq/account"');
    for (const copy of ["Welcome,", "Connect Telegram", "This week", "Take part in another hackathon", "<form"]) expect(html).not.toContain(copy);
  });

  it("opens a sole team directly without repeating its information on Home", async () => {
    mocks.teams.mockResolvedValue([team]);
    const html = await render();
    expect(html).toContain('href="/hq/team/team-1"');
    expect(html).toContain("Worlds Fair");
    expect(html).not.toContain("Tulip");
    expect(html).not.toContain("Take part in another hackathon");
  });

  it("only offers additional hackathons that are currently active", async () => {
    mocks.hackathons.mockResolvedValue([edition,
      { ...edition, id: 2, name: "Another active edition" },
      { ...edition, id: 3, name: "Finished edition", endDate: "2026-09-15" },
      { ...edition, id: 4, name: "Future edition", startDate: "2026-10-01" },
    ]);
    const html = await render();
    expect(html).toContain("Another active edition");
    expect(html).not.toContain("Finished edition");
    expect(html).not.toContain("Future edition");
  });

  it("keeps an existing team reachable after its edition is archived", async () => {
    mocks.hackathons.mockResolvedValue([]);
    mocks.teams.mockResolvedValue([team]);
    expect(await render()).toContain('href="/hq/team/team-1"');
  });

  it.each(["member", "regular"])("keeps an archived hosting request reachable for the %s tier", async (tier) => {
    mocks.hackathons.mockResolvedValue([]);
    mocks.dashboard.mockResolvedValue({ tier, requests: [], enrollments: [], events: [{ id: "event", hackathon_id: edition.id, name: edition.name, title: "Local meetup", status: "pending" }] });
    const html = await render();
    expect(html).toContain('href="/hq/hackathon/900001"');
    expect(html).toContain("Worlds Fair");
    expect(html).not.toContain("Local meetup");
    expect(html).not.toContain("pending");
  });

  it("groups multiple teams into one hackathon menu item", async () => {
    mocks.teams.mockResolvedValue([team, { ...team, id: "team-2", name: "Other team" }]);
    const html = await render();
    expect(html.match(/Worlds Fair/g)).toHaveLength(1);
    expect(html).toContain('href="/hq/hackathon/900001"');
  });

  it("marks unfinished work with one accessible dot and no update summary", async () => {
    mocks.teams.mockResolvedValue([team]);
    mocks.memberWeekSummaries.mockResolvedValue([{ projectId: team.id, projectName: team.name, hackathonId: edition.id, enrolled: true, paused: false, timezone: "Europe/Amsterdam", missedPeriods: 2,
      current: { periodId: "week", startsAt: "2026-09-13T22:00:00Z", endsAt: "2026-09-20T22:00:00Z", completed: false } }]);
    const html = await render();
    expect(html.match(/aria-label="Needs attention"/g)).toHaveLength(1);
    for (const copy of ["Due", "Missed", "Updated", "Add this week", "Tulip"]) expect(html).not.toContain(copy);
  });

  it("does not mark completed work or optional Telegram linking", async () => {
    mocks.teams.mockResolvedValue([team]);
    mocks.memberWeekSummaries.mockResolvedValue([{ projectId: team.id, hackathonId: edition.id, enrolled: true, paused: false, missedPeriods: 2,
      current: { startsAt: "2026-09-13T22:00:00Z", endsAt: "2026-09-20T22:00:00Z", completed: true } }]);
    expect(await render()).not.toContain('aria-label="Needs attention"');
  });

  it("keeps help requests and hosting behind the hackathon tile", async () => {
    mocks.teams.mockResolvedValue([team]);
    mocks.dashboard.mockResolvedValue({ tier: "member", requests: [{ id: "request", hackathon_id: edition.id, name: edition.name, status: "pending", project_url: "https://colosseum.com/project" }], enrollments: [], events: [] });
    const html = await render();
    expect(html).toContain('href="/hq/hackathon/900001"');
    expect(html).not.toContain("Help requested");
    expect(html).not.toContain("pending");
  });

  it("only adds a Captain tile for a Captain", async () => {
    expect(await render()).not.toContain('href="/hq/captain"');
    mocks.requireMemberActor.mockResolvedValue(member({ capabilities: new Set(["captain"]) }));
    expect(await render()).toContain('href="/hq/captain"');
  });
});

describe("the member layout", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  const shell = createElement(BuilderShell, null, createElement("p", null, "content"));
  const render = async () => renderToStaticMarkup(await HqMemberLayout({ children: shell }));

  it("hands the actor's name to the avatar menu of the shell a page renders, and reads nothing else", async () => {
    mocks.currentActor.mockResolvedValue(member({ capabilities: new Set(["captain"]) }));
    const html = await render();
    expect(html).toMatch(/<button[^>]*aria-label="Account menu"[^>]*aria-expanded="false"[^>]*>FB<\/button>/);
    expect(html.match(/<a[^>]*aria-label="Superteam NL home"[^>]*>/)?.[0]).toContain('href="/hq/dashboard"');
    expect(html).toContain("<p>content</p>");
    // The menu is closed in static markup: the name and its items appear only once it opens.
    expect(html).not.toContain("Fictional Builder");
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain("<nav");
    expect(html).not.toContain("HQ navigation");
    for (const label of ["Home", "My teams", "Register team", "Captain", "Connect Telegram", "Account"]) expect(html).not.toContain(`>${label}</a>`);
    // The header needs no team read: the Home page loads the teams it renders.
    expect(mocks.teams).not.toHaveBeenCalled();
    expect(mocks.ownedProjects).not.toHaveBeenCalled();
    expect(readFileSync(join(ROOT, "app/hq/(member)/layout.tsx"), "utf8")).not.toContain("builder-store");
  });

  it("renders no avatar for a visitor, and none for an operator session, which is not a member", async () => {
    mocks.currentActor.mockResolvedValue(null);
    expect(await render()).not.toContain("Account menu");
    mocks.currentActor.mockResolvedValue({ kind: "operator", id: "op", displayName: "Operator" });
    const html = await render();
    expect(html).not.toContain("Account menu");
    expect(html).not.toContain("Operator");
    expect(html).not.toContain("Sign out");
    expect(html).toContain("Superteam NL");
  });
});
