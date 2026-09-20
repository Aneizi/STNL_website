// /hq/captain against the real schema on PGlite. member-shell.test.ts covers
// the page's gate and rendering with everything mocked; this file proves the
// same page against real assignment, grant, project and reporting rows, which
// is the only way to prove the two checks this screen is measured against:
// "Captains cannot inspect other Captains' teams through direct links", and
// "Captain notes never change the team's update status".
import type { PGlite } from "@electric-sql/pglite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  // The Den is a client component, and useRouter() runs when this file
  // renders the page to markup.
  useRouter: () => ({ replace() {}, refresh() {}, push() {} }),
}));
const mocks = vi.hoisted(() => ({ builderDatabase: vi.fn(), requireMemberActor: vi.fn() }));
vi.mock("@/lib/hq/builder-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hq/builder-db")>()),
  builderDatabase: mocks.builderDatabase,
}));
vi.mock("@/lib/hq/actor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hq/actor")>()),
  requireMemberActor: mocks.requireMemberActor,
}));
// The icon package ships its source; this file renders markup, not icons.
vi.mock("symbols-react", () => ({ IconArrowLeft: (props: Record<string, unknown>) => createElement("svg", props) }));

import CaptainPage from "@/app/hq/(member)/captain/page";
import type { MemberActor } from "@/lib/hq/actor";
import type { BuilderDatabase } from "@/lib/hq/builder-db";
import { grantCapability } from "@/lib/hq/capabilities";
import { assignCaptain, unassignCaptain } from "@/lib/hq/captains";
import { createUpdate, enableReporting } from "@/lib/hq/reporting";
import { createMigratedDatabase, pgliteBuilderDatabase } from "./helpers/db";

const OPERATOR = "00000000-0000-4000-8000-000000000001";
const EDITION = 51;
const PROJECT_MINE = "00000000-0000-4000-8000-00000000001a";
const PROJECT_THEIRS = "00000000-0000-4000-8000-00000000001b";
/** A second project of my own, never imported from Colosseum (no hq_project_onboarding row) and not in reporting: the Den's empty-roster branch, listed beside the full one. */
const PROJECT_MINE_BARE = "00000000-0000-4000-8000-00000000001c";
/** A Wednesday inside the first reporting week (14 to 20 September 2026, Europe/Amsterdam). */
const WEDNESDAY_IN_WEEK_ONE = new Date("2026-09-16T10:00:00.000Z");

let pg: PGlite;
let db: BuilderDatabase;
async function rows(text: string, values: unknown[] = []) { return (await pg.query(text, values)).rows as Record<string, unknown>[]; }

function member(id: string, name: string, overrides: Partial<MemberActor> = {}): MemberActor {
  return { kind: "member", id, name, email: null, capabilities: new Set(["captain"]), telegram: { userId: "7" }, ...overrides };
}

const render = async (actor: MemberActor) => {
  mocks.requireMemberActor.mockResolvedValue(actor);
  return renderToStaticMarkup(await CaptainPage());
};
const me = () => member("me", "My Own Name");

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = pgliteBuilderDatabase(pg);
  mocks.builderDatabase.mockReturnValue(db);
}, 30_000);

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useRealTimers();
  // Date alone, not the timers: PGlite needs the real ones. The page and the
  // service both read Date.now(), so the open week is the first one.
  vi.setSystemTime(WEDNESDAY_IN_WEEK_ONE);
  mocks.builderDatabase.mockReturnValue(db);
  await pg.exec(
    `TRUNCATE hq_users, hq_builder_profiles, hq_audit_events, hq_auth_user, hq_account_capabilities,
       hq_hackathons, hq_project_statuses, hq_project_forecasts, hq_crm_persons
     RESTART IDENTITY CASCADE`,
  );
  await rows("INSERT INTO hq_users(id,username,display_name,password_hash) VALUES($1,'operator','Operator','unused')", [OPERATOR]);
  await rows("INSERT INTO hq_hackathons(id,slug,name,start_date,end_date) VALUES($1,'edition','Fictional Edition','2026-09-14','2026-10-12')", [EDITION]);
  await rows("INSERT INTO hq_reporting_config(hackathon_id,final_period_start_date) VALUES($1,'2026-10-05')", [EDITION]);
  await rows("INSERT INTO hq_project_statuses(slug,label,color,counts_as_active,sort) VALUES('active','Active','green',true,1)");
  await rows("INSERT INTO hq_project_forecasts(slug,label,color,sort) VALUES('likely','Likely','green',1)");
  await rows(
    `INSERT INTO hq_builder_profiles(id,email,name) VALUES
       ('me','me@example.test','My Own Name'),('rival','rival@example.test','Rival Captain'),
       ('owner-mine','owner-mine@example.test','Mine Owner'),('owner-theirs','owner-theirs@example.test','Theirs Owner')`,
  );
  // Both real projects are imported teams (hq_project_onboarding present),
  // not just bare hq_projects rows: PROJECT_THEIRS needs a real roster,
  // lead username and Colosseum URL of its own for the "no leak" test below
  // to mean anything. The owner is a separate account from the Captain on
  // each project.
  for (const [id, name, owner, ownerDisplay] of [
    [PROJECT_MINE, "My Secret Project", "owner-mine", "Mine Owner"],
    [PROJECT_THEIRS, "Rival Confidential Project", "owner-theirs", "Theirs Owner"],
  ] as const) {
    await rows(
      `INSERT INTO hq_projects(id,hackathon_id,name,status_id,forecast_id,last_check_in)
       SELECT $1,$2,$3,s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f`,
      [id, EDITION, name],
    );
    await rows(
      `INSERT INTO hq_project_onboarding(project_id,hackathon_id,external_id,project_url,slug,country,raw,owner_user_id,verification,lead_username,team_contact)
       VALUES($1,$2,$3,$4,$5,'Netherlands','{}',$6,'verified',$6,$7)`,
      [id, EDITION, id === PROJECT_MINE ? 9001 : 9002, `https://colosseum.com/arena/projects/explore/${owner}`, owner, owner, `@${owner.replace("-", "_")}`],
    );
    await rows(
      `INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at) VALUES($1,$2,$3,$3,now())`,
      [id, ownerDisplay, owner],
    );
  }
  // A second project of mine, never imported and not in reporting. Named to
  // sort after the imported one, so that one stays selected in every state.
  await rows(
    `INSERT INTO hq_projects(id,hackathon_id,name,status_id,forecast_id,last_check_in)
     SELECT $1,$2,$3,s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f`,
    [PROJECT_MINE_BARE, EDITION, "Side CRM Project"],
  );
  await grantCapability(db, { actor: { kind: "operator", id: OPERATOR }, byOperatorId: OPERATOR, userId: "me", capability: "captain", reason: "test" });
  await grantCapability(db, { actor: { kind: "operator", id: OPERATOR }, byOperatorId: OPERATOR, userId: "rival", capability: "captain", reason: "test" });
  expect(await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: PROJECT_MINE, hackathonId: EDITION, captainUserId: "me" })).toMatchObject({ outcome: "assigned" });
  expect(await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: PROJECT_MINE_BARE, hackathonId: EDITION, captainUserId: "me" })).toMatchObject({ outcome: "assigned" });
  expect(await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: PROJECT_THEIRS, hackathonId: EDITION, captainUserId: "rival" })).toMatchObject({ outcome: "assigned" });
  // An unjoined Colosseum reference on my team, added after the assignment
  // because an unresolved roster row is what makes an assignment need review.
  await rows(
    `INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at) VALUES($1,'Aisha Rahman','aisha_r',NULL,NULL)`,
    [PROJECT_MINE],
  );
  // Only the imported project is in weekly reporting; entering it brings the edition's weeks with it.
  expect(await enableReporting(db, { projectId: PROJECT_MINE, hackathonId: EDITION })).toMatchObject({ ok: true });
});

afterAll(async () => {
  vi.useRealTimers();
  await pg.close();
});

describe("/hq/captain against the real database", () => {
  it("loads imported detail for all assigned projects in one query", async () => {
    const observedQuery = vi.fn(db.query);
    mocks.builderDatabase.mockReturnValue({ ...db, query: observedQuery });
    await render(me());
    const teamReads = observedQuery.mock.calls.filter(([sql]) => sql.includes("AS members") && sql.includes("FROM hq_project_onboarding o"));
    expect(teamReads).toHaveLength(1);
    expect(teamReads[0][1]).toEqual([[PROJECT_MINE, PROJECT_MINE_BARE]]);
  });

  it("renders the Den for a Captain: their teams in the aside, the outstanding one selected with its week, builders, contact and Colosseum link", async () => {
    // The typed contact of the old form: still read as the fallback while no Telegram username is linked.
    await rows("UPDATE hq_builder_profiles SET captain_contact='@my_handle' WHERE id='me'");
    const html = await render(me());
    // The aside: the title, the week, both teams, the outstanding one pressed and marked, and the Captain's own handle.
    expect(html).toContain("Captains&#x27;");
    expect(html).toContain("Week 1 of 4");
    expect(html).toContain("Your teams");
    expect(html).toContain("My Secret Project");
    expect(html).toContain("Side CRM Project");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/aria-label="Not updated"/g)).toHaveLength(1);
    expect(html).not.toContain(">Updated</span>");
    expect(html).toContain("@my_handle");
    // The main column: the status, the imported team's roster with its tags, the team contact as a link, and the Colosseum link.
    expect(html).toContain("Team not updated. Due Sunday 20 September, 23:59 CEST");
    expect(html).toContain("Mine Owner");
    expect(html).toContain(">Lead</span>");
    expect(html).toContain("Aisha Rahman");
    expect(html).toContain(">Not joined</span>");
    expect(html).toContain('href="https://t.me/owner_mine"');
    expect(html).toContain("No update from the team this week.");
    expect(html).toMatch(/colosseum\.com[^"]*owner-mine/i);
    expect(html).toContain("View on Colosseum");
    // The note form for the open week, with the private option and its tooltip in the markup.
    expect(html).toContain("Your note");
    expect(html).toContain("Add note");
    expect(html).toContain("Keep private");
    expect(html).toContain("Only visible to you and HQ admins");
    // Gone with the redesign: the leaderboard, the notes page, the contact form and the Telegram hint.
    for (const copy of ["leaderboard", "Everything you have written", "How your teams should reach you", "Connect Telegram", "No Colosseum team is linked", "Not now"]) {
      expect(html).not.toContain(copy);
    }
    expect(html).not.toMatch(/[—·]/);
  });

  it("leaks no other Captain's name, project, roster, lead, contact or Colosseum link", async () => {
    const html = await render(me());
    expect(html).not.toContain("Rival Captain");
    expect(html).not.toContain("Rival Confidential Project");
    expect(html).not.toContain(PROJECT_THEIRS);
    expect(html).not.toContain("Theirs Owner");
    expect(html).not.toContain("owner_theirs");
    expect(html).not.toMatch(/colosseum\.com[^"]*rival/i);
    expect(html).not.toMatch(/colosseum\.com[^"]*owner-theirs/i);
  });

  it("is not found for a member without the Captain capability", async () => {
    mocks.requireMemberActor.mockResolvedValue(member("plain", "Plain Member", { capabilities: new Set() }));
    await expect(CaptainPage()).rejects.toThrow("NOT_FOUND");
  });

  it("shows the Captain's own private note with its tag, and leaves the team's week not updated until the team writes", async () => {
    const note = await createUpdate(me(), { projectId: PROJECT_MINE, hackathonId: EDITION, body: "Aisha still has not joined HQ, nudged her on Telegram.", visibility: "sensitive" }, db);
    expect(note).toMatchObject({ ok: true, completesPeriod: false });
    let html = await render(me());
    expect(html).toContain("Earlier");
    expect(html).toContain("Aisha still has not joined HQ, nudged her on Telegram.");
    expect(html).toContain("You, 16 September");
    expect(html).toContain('title="Only visible to you and HQ admins"');
    expect(html).toContain(">Private</span>");
    // A note about the team is not the team's update: the status, the aside marker and the last-update line all still say so.
    expect(html).toContain("Team not updated. Due Sunday 20 September, 23:59 CEST");
    expect(html).toContain('aria-label="Not updated"');
    expect(html).not.toContain(">Updated</span>");
    expect(html).toContain("No update from the team this week.");
    expect(html).toContain(">Your note</p>");
    // Notes on the Den are read only.
    expect(html).not.toMatch(/>Edit</);

    const update = await createUpdate(member("owner-mine", "Mine Owner", { capabilities: new Set() }), { projectId: PROJECT_MINE, hackathonId: EDITION, body: "Shipped the QR checkout flow on devnet." }, db);
    expect(update).toMatchObject({ ok: true, completesPeriod: true });
    html = await render(me());
    expect(html).toContain("Team updated this week. No note needed");
    expect(html).toContain(">Updated</span>");
    expect(html).not.toContain('aria-label="Not updated"');
    expect(html).toContain("Your note (optional)");
    expect(html).toContain("Last update: Mine Owner, 16 September.");
    expect(html).toContain("Shipped the QR checkout flow on devnet.");
    expect(html).toContain("Mine Owner, 16 September");
    expect(html.match(/>Private<\/span>/g)).toHaveLength(1);
    expect(html).not.toMatch(/[—·]/);
  });

  it("renders a project that was never imported with no builders, no Colosseum link and no note form outside reporting", async () => {
    await unassignCaptain(db, { actorOperatorId: OPERATOR, projectId: PROJECT_MINE, hackathonId: EDITION });
    const html = await render(me());
    expect(html).toContain("Side CRM Project");
    expect(html).not.toContain("My Secret Project");
    expect(html).toContain("Builders");
    expect(html).not.toContain("View on Colosseum");
    expect(html).not.toContain("colosseum.com");
    expect(html).toContain("Not shared yet.");
    // Not in reporting: no open week, so no marker in the aside and nothing to write.
    expect(html).toContain("No open week");
    expect(html).not.toContain('aria-label="Not updated"');
    expect(html).not.toContain("Add note");
    expect(html).not.toContain("<textarea");
  });

  it("says so in one line for a Captain with no assignments", async () => {
    await unassignCaptain(db, { actorOperatorId: OPERATOR, projectId: PROJECT_MINE, hackathonId: EDITION });
    await unassignCaptain(db, { actorOperatorId: OPERATOR, projectId: PROJECT_MINE_BARE, hackathonId: EDITION });
    const html = await render(me());
    expect(html).toContain("No teams assigned yet.");
    expect(html).toContain("Your teams");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("No assignments yet");
  });
});
