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
  currentMember: vi.fn(),
  requireMemberActor: vi.fn(),
  teams: vi.fn(),
  ownedProjects: vi.fn(),
  currentHackathonId: vi.fn(),
  teamById: vi.fn(),
  leaderboard: vi.fn(),
  listAssignments: vi.fn(),
  captainReportingBoard: vi.fn(),
  memberWeekSummaries: vi.fn(),
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
vi.mock("@/lib/hq/member-auth", () => ({ currentMember: mocks.currentMember, requireMember: vi.fn() }));
vi.mock("@/lib/hq/builder-store", () => ({
  builderStore: () => ({
    teams: mocks.teams,
    ownedProjects: mocks.ownedProjects,
    currentHackathonId: mocks.currentHackathonId,
    teamById: mocks.teamById,
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
    // The entry card the team page and the Captains' Den share.
    "components/hq/reporting-entry-card.tsx",
    // The team dossier and its late-update modal.
    "components/hq/team-workspace.tsx",
    "components/hq/late-update-modal.tsx",
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
  const team = { id: "team-1", name: "Tulip", hackathonId: 41, hackathonName: "Edition A", verification: "verified" };
  const week = (completed: boolean) => ({
    projectId: team.id, projectName: team.name, hackathonId: team.hackathonId, timezone: "Europe/Amsterdam",
    enrolled: true, paused: false, missedPeriods: 0, totalPeriods: 4,
    current: { periodId: "week-1", periodSequence: 1, startDate: "2026-09-14", endDate: "2026-09-20", startsAt: "2026-09-13T22:00:00Z", endsAt: "2026-09-20T22:00:00Z", completed },
  });
  const AT = Date.parse("2026-09-16T12:00:00Z");
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AT));
    mocks.requireMemberActor.mockResolvedValue(member());
    mocks.teams.mockResolvedValue([]);
    mocks.ownedProjects.mockResolvedValue([]);
    mocks.currentHackathonId.mockResolvedValue(41);
    mocks.memberWeekSummaries.mockResolvedValue([]);
    mocks.listAssignments.mockResolvedValue([]);
    mocks.builderDatabase.mockReturnValue({});
  });
  afterEach(() => vi.useRealTimers());
  const render = async (welcome?: string) => renderToStaticMarkup(await DashboardPage({ searchParams: Promise.resolve({ welcome }) }));
  /** The three tiles' markup, in order: hackathon, Member Portal, Captains' Den. */
  const tiles = (html: string) => html.split("<li").slice(1);

  it("greets the member by first name over exactly three tiles, and nothing of the old menu", async () => {
    const html = await render();
    expect(mocks.requireMemberActor).toHaveBeenCalledWith("/hq/dashboard");
    expect(html).toContain("Where to, Fictional?");
    expect(html).toContain('aria-label="Home menu"');
    expect(tiles(html)).toHaveLength(3);
    expect(html).toContain('aria-label="Superteam NL home"');
    for (const copy of ['href="/hq/account"', "Get help", "/hq/hackathon/", "<form", ">Home<", ">Back<", "Needs attention", "Connect Telegram"]) expect(html).not.toContain(copy);
    expect(html).not.toMatch(/[—·]/);
    expect(html.toLowerCase()).not.toMatch(/operator|hq-chrome/);
  });

  it("asks who is signed in before reading anything, and greets an account without a name plainly", async () => {
    const order: string[] = [];
    mocks.requireMemberActor.mockImplementation(async () => { order.push("gate"); return member({ name: "  " }); });
    mocks.teams.mockImplementation(async () => { order.push("teams"); return []; });
    mocks.ownedProjects.mockImplementation(async () => { order.push("owned"); return []; });
    mocks.currentHackathonId.mockImplementation(async () => { order.push("edition"); return 41; });
    const html = await render();
    expect(order).toEqual(["gate", "teams", "owned", "edition"]);
    expect(html).toContain("Where to?");
    expect(html).not.toContain("Where to,");
  });

  it("invites an account without a team to initialize one, with no week and no due mark", async () => {
    const html = await render();
    const [hackathon] = tiles(html);
    expect(hackathon).toContain('href="/hq/initialize"');
    for (const copy of ["Crypto World&#x27;s Fair", "Initialize<br/>your team", "Link your Colosseum project to start"]) expect(hackathon).toContain(copy);
    for (const copy of ["Update due", "Colosseum Hackathon 2026", "Week "]) expect(hackathon).not.toContain(copy);
    expect(mocks.memberWeekSummaries).not.toHaveBeenCalled();
  });

  it("opens the team straight from the hackathon tile, with the week and the due mark, and never the team's name", async () => {
    mocks.teams.mockResolvedValue([team]);
    mocks.memberWeekSummaries.mockResolvedValue([week(false)]);
    const html = await render();
    const [hackathon] = tiles(html);
    expect(hackathon).toContain('href="/hq/team/team-1"');
    for (const copy of ["Week 1 of 4", "Update due", "Crypto<br/>World&#x27;s Fair", "Colosseum Hackathon 2026"]) expect(hackathon).toContain(copy);
    for (const copy of ["Tulip", "/hq/initialize", "Link your Colosseum project"]) expect(html).not.toContain(copy);
    expect(mocks.memberWeekSummaries).toHaveBeenCalledWith([team], undefined, AT);
  });

  it("drops the due mark once the week is updated, and the week label when no week is open", async () => {
    mocks.teams.mockResolvedValue([team]);
    mocks.memberWeekSummaries.mockResolvedValue([week(true)]);
    let [hackathon] = tiles(await render());
    expect(hackathon).toContain("Week 1 of 4");
    expect(hackathon).not.toContain("Update due");
    mocks.memberWeekSummaries.mockResolvedValue([{ ...week(false), current: null }]);
    [hackathon] = tiles(await render());
    expect(hackathon).toContain('href="/hq/team/team-1"');
    expect(hackathon).toContain("Colosseum Hackathon 2026");
    for (const copy of ["Week ", "Update due", "Crypto World&#x27;s Fair"]) expect(hackathon).not.toContain(copy);
  });

  it("picks the current edition's verified team, then the newest, over everything else the account holds", async () => {
    const older = { ...team, id: "team-old", hackathonId: 7 };
    mocks.teams.mockResolvedValue([older, team, { ...team, id: "team-pending", verification: "pending" }]);
    mocks.ownedProjects.mockResolvedValue([{ id: "project-9", name: "Manual project", hackathonId: 41, hackathonName: "Edition A" }]);
    let html = await render();
    expect(html).toContain('href="/hq/team/team-1"');
    for (const id of ["team-old", "team-pending", "project-9"]) expect(html).not.toContain(id);
    expect(mocks.memberWeekSummaries).toHaveBeenCalledWith([team], undefined, AT);
    mocks.currentHackathonId.mockResolvedValue(null);
    html = await render();
    expect(html).toContain('href="/hq/team/team-old"');
    mocks.teams.mockResolvedValue([{ ...team, verification: "pending" }]);
    html = await render();
    expect(html).toContain('href="/hq/team/project-9"');
    expect(html).not.toContain("Manual project");
  });

  it("keeps the Member Portal under construction, and not a link", async () => {
    const [, portal] = tiles(await render());
    expect(portal).toContain('aria-disabled="true"');
    expect(portal).toContain("Under construction");
    expect(portal).toContain("Member<br/>Portal");
    expect(portal).not.toContain("href=");
  });

  it("locks the Captains' Den without the capability, and reads no assignments", async () => {
    const [, , den] = tiles(await render());
    expect(den).toContain('aria-disabled="true"');
    expect(den).toContain("Captains only");
    expect(den).toContain("Captains&#x27;<br/>Den");
    // The closed padlock, drawn from components/hq/icons at full colour.
    expect(den).toMatch(/<svg[^>]*width="14"[^>]*height="20"[^>]*viewBox="0 0 13\.6914 19\.6777"[^>]*fill="currentColor"[^>]*aria-hidden="true"/);
    for (const copy of ["href=", "assigned to you", "fill-opacity"]) expect(den).not.toContain(copy);
    expect(mocks.listAssignments).not.toHaveBeenCalled();
  });

  it("shows the welcome popup only on a new Captain's arrival", async () => {
    expect(await render("captain")).not.toContain('id="captain-welcome-title"');
    mocks.requireMemberActor.mockResolvedValue(member({ capabilities: new Set(["captain"]) }));
    expect(await render()).not.toContain('id="captain-welcome-title"');
    const html = await render("captain");
    expect(html).toContain('id="captain-welcome-title"');
    expect(html).toContain("You&#x27;re now a captain.");
    expect(html).toContain(">Okay</button>");
  });

  it("opens the Captains' Den for a Captain with this edition's own assignment count", async () => {
    mocks.requireMemberActor.mockResolvedValue(member({ capabilities: new Set(["captain"]) }));
    const db = { marker: "builder-pool" };
    mocks.builderDatabase.mockReturnValue(db);
    mocks.listAssignments.mockResolvedValue([{ projectId: "p1", projectName: "Alpha" }, { projectId: "p2", projectName: "Beta" }]);
    let [, , den] = tiles(await render());
    expect(den).toContain('href="/hq/captain"');
    expect(den).toContain("2 teams assigned to you");
    expect(den).toMatch(/<svg[^>]*width="21"[^>]*height="20"[^>]*viewBox="0 0 20\.459 19\.6387"/);
    for (const copy of ["aria-disabled", "Alpha", "Beta", "p1"]) expect(den).not.toContain(copy);
    expect(mocks.listAssignments).toHaveBeenCalledWith(db, { hackathonId: 41, captainUserId: "acct-1" });
    mocks.listAssignments.mockResolvedValue([{ projectId: "p1", projectName: "Alpha" }]);
    [, , den] = tiles(await render());
    expect(den).toContain("1 team assigned to you");
    // No current edition means no assignment list to read, and a count of none.
    mocks.currentHackathonId.mockResolvedValue(null);
    mocks.listAssignments.mockClear();
    [, , den] = tiles(await render());
    expect(den).toContain("0 teams assigned to you");
    expect(mocks.listAssignments).not.toHaveBeenCalled();
  });
});

describe("the member layout", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  const shell = createElement(BuilderShell, null, createElement("p", null, "content"));
  const render = async () => renderToStaticMarkup(await HqMemberLayout({ children: shell }));

  it("hands the member's name to the avatar menu of the shell a page renders, and reads nothing else", async () => {
    mocks.currentMember.mockResolvedValue({ id: "acct-1", name: "Fictional Builder", email: null });
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
    expect(mocks.currentActor).not.toHaveBeenCalled();
    expect(readFileSync(join(ROOT, "app/hq/(member)/layout.tsx"), "utf8")).not.toContain("builder-store");
  });

  it("renders no avatar without a member session, even when an operator is signed in", async () => {
    mocks.currentMember.mockResolvedValue(null);
    mocks.currentActor.mockResolvedValue(null);
    expect(await render()).not.toContain("Account menu");
    mocks.currentActor.mockResolvedValue({ kind: "operator", id: "op", displayName: "Operator" });
    const html = await render();
    expect(html).not.toContain("Account menu");
    expect(html).not.toContain("Operator");
    expect(html).not.toContain("Sign out");
    expect(html).toContain("Superteam NL");
  });

  it("keeps the Telegram member's account menu when an admin session is also present", async () => {
    mocks.currentActor.mockResolvedValue({ kind: "operator", id: "op", displayName: "Operator" });
    mocks.currentMember.mockResolvedValue({ id: "telegram-member", name: "Telegram Builder", email: null });
    const html = await render();
    expect(html).toMatch(/aria-label="Account menu"[^>]*>TB<\/button>/);
    expect(html).not.toContain("Operator");
    expect(mocks.currentActor).not.toHaveBeenCalled();
  });
});
