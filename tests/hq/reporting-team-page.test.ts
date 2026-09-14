// /hq/team/<id>'s weekly reporting section, rendered against real rows on
// PGlite. The acceptance bullets this file is measured against:
//
// - "Saved updates immediately update the relevant views; completion stops
//   the prompt."
// - "Sensitive notes can make the status Updated even when there is no new
//   shared entry to display. Do not show a hidden-note preview or count."
// - "Show the assigned Captain and their approved contact when available."
// - "Interface copy contains no em dashes or middots."
//
// Only the session read is stubbed. The authorization decisions, the audience
// SQL and the week arithmetic are the real ones, so what is asserted here is
// what a team member's browser would actually receive.
import type { PGlite } from "@electric-sql/pglite";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); },
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
vi.mock("symbols-react", () => ({
  IconArrowRight: () => null,
  IconTelegramLogo: () => null,
}));

import TeamPage from "@/app/hq/(member)/team/[id]/page";
import type { MemberActor } from "@/lib/hq/actor";
import type { BuilderDatabase } from "@/lib/hq/builder-db";
import { grantCapability } from "@/lib/hq/capabilities";
import { assignCaptain } from "@/lib/hq/captains";
import { writeCaptainContact } from "@/lib/hq/reporting-contacts";
import { createUpdate, enableReporting, listReportingPeriods } from "@/lib/hq/reporting";
import { createMigratedDatabase, pgliteBuilderDatabase } from "./helpers/db";

const OPERATOR_ID = "00000000-0000-4000-8000-0000000000c1";
const EDITION = 81;
const PROJECT = "00000000-0000-4000-9200-000000000001";

let pg: PGlite;
let db: BuilderDatabase;

async function rows(text: string, values: unknown[] = []) {
  return (await pg.query(text, values)).rows as Record<string, unknown>[];
}

function member(id: string, capabilities: "captain"[] = []): MemberActor {
  return { kind: "member", id, name: id, email: `${id}@example.test`, capabilities: new Set(capabilities), telegram: null };
}

const render = async (actor: MemberActor) => {
  mocks.requireMemberActor.mockResolvedValue(actor);
  return renderToStaticMarkup(await TeamPage({ params: Promise.resolve({ id: PROJECT }) }));
};

async function seedAccount(id: string) {
  await rows(`INSERT INTO hq_auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,true) ON CONFLICT (id) DO NOTHING`, [id, id, `${id}@example.test`]);
  await rows(`INSERT INTO hq_builder_profiles(id,email,name) VALUES($1,$2,$3) ON CONFLICT (id) DO NOTHING`, [id, `${id}@example.test`, id]);
}

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = pgliteBuilderDatabase(pg);
  mocks.builderDatabase.mockReturnValue(db);
  await rows(`INSERT INTO hq_users(id,username,display_name,password_hash) VALUES($1,'op','Operator','x')`, [OPERATOR_ID]);
  await rows(`INSERT INTO hq_project_statuses(slug,label,color,counts_as_active,sort) VALUES('onboarding','Onboarding','accent',true,100)`);
  await rows(`INSERT INTO hq_project_forecasts(slug,label,color,sort) VALUES('unassessed','Not assessed','muted',100)`);
}, 30_000);

afterAll(async () => { await pg.close(); });

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mocks.builderDatabase.mockReturnValue(db);
  await pg.exec(`
    DELETE FROM hq_reporting_entries; DELETE FROM hq_reporting_outcomes; DELETE FROM hq_reporting_eligibility;
    DELETE FROM hq_reporting_periods; DELETE FROM hq_reporting_config;
    DELETE FROM hq_captain_assignments; DELETE FROM hq_account_capabilities; DELETE FROM hq_audit_events;
    DELETE FROM hq_project_members; DELETE FROM hq_project_onboarding; DELETE FROM hq_projects;
    DELETE FROM hq_builder_enrollments; DELETE FROM hq_people; DELETE FROM hq_crm_persons;
    DELETE FROM hq_builder_profiles; DELETE FROM hq_auth_user;
    DELETE FROM hq_settings; DELETE FROM hq_hackathons;
  `);
  await rows(`INSERT INTO hq_hackathons(id,slug,name,start_date,end_date) VALUES($1,'worlds-fair','Worlds Fair','2026-09-14','2026-10-12')`, [EDITION]);
  await rows(`INSERT INTO hq_reporting_config(hackathon_id,final_period_start_date) VALUES($1,'2026-10-05')`, [EDITION]);

  await rows(
    `INSERT INTO hq_projects(id,hackathon_id,name,status_id,forecast_id,last_check_in)
     SELECT $1,$2,'Our Team',s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f LIMIT 1`,
    [PROJECT, EDITION],
  );
  for (const id of ["lead", "mate", "cap"]) await seedAccount(id);
  await rows(
    `INSERT INTO hq_project_onboarding(project_id,hackathon_id,external_id,project_url,slug,raw,owner_user_id,verification,lead_username)
     VALUES($1,$2,4242,'https://colosseum.com/arena/projects/explore/ours','ours','{}','lead','verified','lead')`,
    [PROJECT, EDITION],
  );
  for (const id of ["lead", "mate"]) {
    await rows(`INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at) VALUES($1,$2,$2,$2,now())`, [PROJECT, id]);
  }
  await enableReporting(db, { projectId: PROJECT, hackathonId: EDITION });
});

/** Makes "cap" the project's current Captain, with a contact they approved. */
async function assignCaptainWithContact(contact: string | null) {
  await grantCapability(db, { actor: { kind: "operator", id: OPERATOR_ID }, byOperatorId: OPERATOR_ID, userId: "cap", capability: "captain", reason: "test" });
  const assigned = await assignCaptain(db, { actorOperatorId: OPERATOR_ID, projectId: PROJECT, hackathonId: EDITION, captainUserId: "cap" });
  if (assigned.outcome !== "assigned") throw new Error(`could not assign: ${JSON.stringify(assigned)}`);
  if (contact) await writeCaptainContact(db, "cap", contact);
}

/** The instant a Monday inside the first reporting week falls at. */
const MONDAY_IN_WEEK_ONE = Date.parse("2026-09-14T10:00:00.000Z");

describe("the team page's weekly reporting", () => {
  it("shows the open week, its dates and its deadline, and says the week is not updated yet", async () => {
    const html = await render(member("lead"));
    expect(html).toContain("This week");
    expect(html).toContain("Not updated");
    expect(html).toContain("14 to 20 September");
    expect(html).toContain("Sunday 20 September");
    expect(html).toContain("No updates yet for this week.");
  });

  it("shows a saved update, marks the week Updated and offers the author an edit", async () => {
    const saved = await createUpdate(member("lead"), { projectId: PROJECT, hackathonId: EDITION, body: "Shipped the swap flow." }, db);
    expect(saved.ok).toBe(true);
    const html = await render(member("lead"));
    expect(html).toContain("Shipped the swap flow.");
    expect(html).toContain("Updated");
    expect(html).toContain("Edit this update");
  });

  it("shows a teammate's update to the rest of the team, without offering them an edit", async () => {
    await createUpdate(member("lead"), { projectId: PROJECT, hackathonId: EDITION, body: "Shipped the swap flow." }, db);
    const html = await render(member("mate"));
    expect(html).toContain("Shipped the swap flow.");
    expect(html).not.toContain("Edit this update");
  });

  it("prompts on a Monday while the week is outstanding, and stops once it is complete", async () => {
    vi.setSystemTime(new Date(MONDAY_IN_WEEK_ONE));
    try {
      expect(await render(member("lead"))).toContain("This week still needs an update");
      await createUpdate(member("lead"), { projectId: PROJECT, hackathonId: EDITION, body: "Done." }, db);
      const after = await render(member("lead"));
      expect(after).not.toContain("This week still needs an update");
      expect(after).toContain("Updated");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not prompt on a Wednesday, whatever the week's state", async () => {
    vi.setSystemTime(new Date("2026-09-16T10:00:00.000Z"));
    try {
      expect(await render(member("lead"))).not.toContain("This week still needs an update");
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the week Updated on a Captain's sensitive note without showing the team the note, a preview or a count", async () => {
    await assignCaptainWithContact(null);
    const note = await createUpdate(
      member("cap", ["captain"]),
      { projectId: PROJECT, hackathonId: EDITION, body: "A private worry about the lead.", visibility: "sensitive" },
      db,
    );
    expect(note).toMatchObject({ ok: true, completesPeriod: true });

    const html = await render(member("lead"));
    expect(html).toContain("Updated");
    // Not the body, not its existence, and no count that invites a look.
    expect(html).not.toContain("A private worry");
    expect(html).not.toMatch(/sensitive/i);
    // No count either, and nothing that says an update exists: the team sees
    // Updated, and the list below it is genuinely empty.
    expect(html).toContain("No updates yet for this week.");
    expect(html).not.toMatch(/1 update|note from|private/i);
  });

  it("shows the assigned Captain and the contact they approved, and says so plainly when they approved none", async () => {
    await assignCaptainWithContact(null);
    expect(await render(member("lead"))).toContain("They have not shared a way to reach them yet.");
    await writeCaptainContact(db, "cap", "@thecaptain");
    const html = await render(member("lead"));
    expect(html).toContain("Reach them at @thecaptain");
  });

  it("keeps the team able to update while no Captain is assigned", async () => {
    const html = await render(member("lead"));
    expect(html).toContain("No Captain assigned yet. You can still add your updates.");
    expect(html).toContain("Add update");
  });

  it("offers the team lead the team contact field, and does not offer it to a teammate", async () => {
    expect(await render(member("lead"))).toContain("How your Captain should reach the team");
    expect(await render(member("mate"))).not.toContain("How your Captain should reach the team");
  });

  it("says a paused team owes nothing and drops the composer, leaving the recorded weeks alone", async () => {
    await rows("UPDATE hq_reporting_eligibility SET paused_at = now() WHERE project_id = $1::uuid", [PROJECT]);
    const html = await render(member("lead"));
    expect(html).toContain("Reporting paused");
    expect(html).not.toContain("Add update");
  });

  it("names a week the composer is bound to, so a save that crosses midnight has something to compare against", async () => {
    const [first] = await listReportingPeriods(db, EDITION);
    expect(first.startDate).toBe("2026-09-14");
    expect(await render(member("lead"))).toContain("Your update for this week");
  });

  it("uses no em dash and no middot anywhere on the page", async () => {
    await assignCaptainWithContact("@thecaptain");
    await createUpdate(member("lead"), { projectId: PROJECT, hackathonId: EDITION, body: "Shipped it." }, db);
    expect(await render(member("lead"))).not.toMatch(/[—·]/);
  });
});
