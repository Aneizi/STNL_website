// The reporting service against the real schema on PGlite: the edition's
// schedule read from its own hackathon record, eligibility, entries and
// their revisions, the audience rules, grouped status and period closure.
//
// Nothing here is mocked except `server-only`: the authorization decisions
// are the real ones from lib/hq/authz.ts over real rows, so a privacy
// assertion below is an assertion about what the service would actually
// return in production.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ builderDatabase: vi.fn() }));
vi.mock("@/lib/hq/builder-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hq/builder-db")>()),
  builderDatabase: mocks.builderDatabase,
}));

import type { Actor } from "@/lib/hq/actor";
import type { BuilderDatabase } from "@/lib/hq/builder-db";
import { grantCapability } from "@/lib/hq/capabilities";
import { assignCaptain } from "@/lib/hq/captains";
import {
  closePeriod,
  correctOutcome,
  createUpdate,
  currentReportingPeriod,
  editUpdate,
  enableReporting,
  ensureReportingPeriods,
  listReportingPeriods,
  pauseReporting,
  previewReportingPeriods,
  readAuthorizedUpdates,
  readReportingSchedule,
  readRevisionHistory,
  reportingEligibility,
  reportingStatus,
  voidUpdate,
} from "@/lib/hq/reporting";
import { deletePersonRecord, deleteTeamRecord, teamRemovalImpact } from "@/lib/hq/record-deletion";
import { createMigratedDatabase, pgliteBuilderDatabase } from "./helpers/db";

const OPERATOR_ID = "00000000-0000-4000-8000-0000000000a1";
const EDITION = 61;
const OTHER_EDITION = 62;
const PROJECT_A = "00000000-0000-4000-9000-000000000001";
const PROJECT_B = "00000000-0000-4000-9000-000000000002";
/** A project an admin added straight into the CRM: no hq_project_onboarding row, no roster, no Colosseum link. */
const BARE_PROJECT = "00000000-0000-4000-9000-000000000003";

let pg: PGlite;
let db: BuilderDatabase;

async function rows(text: string, values: unknown[] = []) {
  return (await pg.query(text, values)).rows as Record<string, unknown>[];
}

const OPERATOR: Actor = { kind: "operator", id: OPERATOR_ID, displayName: "Operator" };

function member(id: string, capabilities: "captain"[] = []): Actor {
  return { kind: "member", id, name: id, email: `${id}@example.test`, capabilities: new Set(capabilities), telegram: null };
}

async function seedAccount(id: string) {
  await rows(`INSERT INTO hq_auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,true) ON CONFLICT (id) DO NOTHING`, [id, id, `${id}@example.test`]);
  await rows(`INSERT INTO hq_builder_profiles(id,email,name) VALUES($1,$2,$3) ON CONFLICT (id) DO NOTHING`, [id, `${id}@example.test`, id]);
}

/** A bare hq_projects row: what an Admin-created project that was never imported looks like. */
async function seedProject(id: string, hackathonId = EDITION, name = "Project") {
  await rows(
    `INSERT INTO hq_projects(id,hackathon_id,name,status_id,forecast_id,last_check_in)
     SELECT $1,$2,$3,s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f LIMIT 1`,
    [id, hackathonId, name],
  );
}

/** A bare project plus the imported team over it: a verified owner and a joined roster row. */
async function seedImportedProject(id: string, owner: string, options: { hackathonId?: number; members?: string[]; name?: string } = {}) {
  const hackathonId = options.hackathonId ?? EDITION;
  await seedProject(id, hackathonId, options.name ?? "Project");
  await seedAccount(owner);
  await rows(
    `INSERT INTO hq_project_onboarding(project_id,hackathon_id,external_id,project_url,slug,raw,owner_user_id,verification,lead_username)
     VALUES($1,$2,$3,$4,$5,'{}',$6,'verified',$6)`,
    [id, hackathonId, Math.abs(hashCode(id)), `https://colosseum.com/arena/projects/explore/${owner}`, owner, owner],
  );
  await rows(`INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at) VALUES($1,$2,$2,$2,now())`, [id, owner]);
  for (const teammate of options.members ?? []) {
    await seedAccount(teammate);
    await rows(`INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at) VALUES($1,$2,$2,$2,now())`, [id, teammate]);
  }
}

function hashCode(value: string): number {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return hash;
}

/** An account with an active `captain` grant, assigned to the project. */
async function seedAssignedCaptain(userId: string, projectId: string) {
  await seedAccount(userId);
  await grantCapability(db, { actor: { kind: "operator", id: OPERATOR_ID }, byOperatorId: OPERATOR_ID, userId, capability: "captain", reason: "test" });
  const result = await assignCaptain(db, { actorOperatorId: OPERATOR_ID, projectId, hackathonId: EDITION, captainUserId: userId });
  if (result.outcome !== "assigned") throw new Error(`could not assign the test Captain: ${JSON.stringify(result)}`);
}

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = pgliteBuilderDatabase(pg);
  mocks.builderDatabase.mockReturnValue(db);
  await rows(`INSERT INTO hq_users(id,username,display_name,password_hash) VALUES($1,'op','Operator','x')`, [OPERATOR_ID]);
  await rows(`INSERT INTO hq_project_statuses(slug,label,color,counts_as_active,sort) VALUES('onboarding','Onboarding','accent',true,100)`);
  await rows(`INSERT INTO hq_project_forecasts(slug,label,color,sort) VALUES('unassessed','Not assessed','muted',100)`);
});

afterAll(async () => { await pg.close(); });

beforeEach(async () => {
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
  await rows(`INSERT INTO hq_hackathons(id,slug,name,start_date,end_date) VALUES($1,'frontier','Frontier','2026-05-04','2026-05-31')`, [OTHER_EDITION]);
  await rows(`INSERT INTO hq_reporting_config(hackathon_id,final_period_start_date) VALUES($1,'2026-10-05')`, [EDITION]);
});

describe("readReportingSchedule", () => {
  it("reads the campaign window from the hackathon's own record, never from Colosseum", async () => {
    expect(await readReportingSchedule(db, EDITION)).toEqual({
      startDate: "2026-09-14", endDate: "2026-10-12", timezone: "Europe/Amsterdam",
      finalPeriodStartDate: "2026-10-05", nudgeWeekday: 3, nudgeTime: "12:00",
    });
  });

  it("uses the campaign timezone from hq_settings rather than a second copy of its own", async () => {
    await rows(`INSERT INTO hq_settings(hackathon_id,key,value) VALUES($1,'timezone','"America/New_York"'::jsonb)`, [EDITION]);
    expect((await readReportingSchedule(db, EDITION))?.timezone).toBe("America/New_York");
  });

  it("falls back to a purely weekly schedule for an edition with no reporting configuration", async () => {
    expect(await readReportingSchedule(db, OTHER_EDITION)).toEqual({
      startDate: "2026-05-04", endDate: "2026-05-31", timezone: "Europe/Amsterdam",
      finalPeriodStartDate: null, nudgeWeekday: 3, nudgeTime: "12:00",
    });
  });

  it("returns null for an edition that does not exist", async () => {
    expect(await readReportingSchedule(db, 999)).toBeNull();
  });
});

describe("ensureReportingPeriods", () => {
  it("stores the generated schedule once and changes nothing on a second call", async () => {
    const first = await ensureReportingPeriods(db, EDITION);
    expect(first.added).toBe(4);
    expect(first.updated).toBe(0);
    expect(first.periods.map((period) => [period.sequence, period.mode, period.startDate, period.endDate])).toEqual([
      [1, "weekly", "2026-09-14", "2026-09-20"],
      [2, "weekly", "2026-09-21", "2026-09-27"],
      [3, "weekly", "2026-09-28", "2026-10-04"],
      [4, "submission", "2026-10-05", "2026-10-12"],
    ]);
    const second = await ensureReportingPeriods(db, EDITION);
    expect([second.added, second.updated, second.conflicts.length]).toEqual([0, 0, 0]);
    expect(second.periods.map((period) => period.id)).toEqual(first.periods.map((period) => period.id));
  });

  it("scopes periods to their edition", async () => {
    await ensureReportingPeriods(db, EDITION);
    await ensureReportingPeriods(db, OTHER_EDITION);
    expect((await listReportingPeriods(db, OTHER_EDITION)).map((period) => period.startDate)).toEqual([
      "2026-05-04", "2026-05-11", "2026-05-18", "2026-05-25",
    ]);
  });

  it("moves a period nobody has reported in when the campaign dates change", async () => {
    const before = await ensureReportingPeriods(db, EDITION);
    await rows(`UPDATE hq_hackathons SET start_date='2026-09-21' WHERE id=$1`, [EDITION]);
    const after = await ensureReportingPeriods(db, EDITION);
    expect(after.updated).toBeGreaterThan(0);
    expect(after.periods[0].startDate).toBe("2026-09-21");
    // The row is moved, not replaced: its id is the stable period identity.
    expect(after.periods[0].id).toBe(before.periods[0].id);
  });

  it("refuses to relabel a period that already holds an entry, and reports it instead", async () => {
    const stored = await ensureReportingPeriods(db, EDITION);
    await seedImportedProject(PROJECT_A, "lead-a");
    await rows(
      `INSERT INTO hq_reporting_entries(project_id,period_id,author_kind,author_id,body) VALUES($1,$2,'member','lead-a','Week one')`,
      [PROJECT_A, stored.periods[0].id],
    );
    await rows(`UPDATE hq_hackathons SET start_date='2026-09-21' WHERE id=$1`, [EDITION]);
    const after = await ensureReportingPeriods(db, EDITION);
    expect(after.conflicts).toEqual([
      expect.objectContaining({ sequence: 1, reason: "has_entries", storedStartDate: "2026-09-14", generatedStartDate: "2026-09-21" }),
    ]);
    expect((await listReportingPeriods(db, EDITION))[0].startDate).toBe("2026-09-14");
  });

  it("refuses to relabel a period that is already closed", async () => {
    const stored = await ensureReportingPeriods(db, EDITION);
    await rows(`UPDATE hq_reporting_periods SET closed_at=now() WHERE id=$1`, [stored.periods[0].id]);
    await rows(`UPDATE hq_hackathons SET start_date='2026-09-21' WHERE id=$1`, [EDITION]);
    const after = await ensureReportingPeriods(db, EDITION);
    expect(after.conflicts[0]).toMatchObject({ sequence: 1, reason: "closed" });
  });

  it("removes a trailing period nobody used when the campaign is shortened, and keeps one that was used", async () => {
    const stored = await ensureReportingPeriods(db, EDITION);
    await rows(`UPDATE hq_hackathons SET end_date='2026-09-27' WHERE id=$1`, [EDITION]);
    await rows(`UPDATE hq_reporting_config SET final_period_start_date=NULL WHERE hackathon_id=$1`, [EDITION]);
    const shortened = await ensureReportingPeriods(db, EDITION);
    expect(shortened.removed).toBe(2);
    expect(shortened.periods.map((period) => period.sequence)).toEqual([1, 2]);

    // Put them back, record something in the last one, then shorten again.
    await ensureReportingPeriods(db, EDITION);
    await rows(`UPDATE hq_hackathons SET end_date='2026-10-12' WHERE id=$1`, [EDITION]);
    const restored = await ensureReportingPeriods(db, EDITION);
    await seedImportedProject(PROJECT_A, "lead-a");
    const last = restored.periods[restored.periods.length - 1];
    await rows(
      `INSERT INTO hq_reporting_entries(project_id,period_id,author_kind,author_id,body) VALUES($1,$2,'member','lead-a','Final week')`,
      [PROJECT_A, last.id],
    );
    await rows(`UPDATE hq_hackathons SET end_date='2026-09-27' WHERE id=$1`, [EDITION]);
    const again = await ensureReportingPeriods(db, EDITION);
    expect(again.conflicts.some((conflict) => conflict.sequence === last.sequence && conflict.reason === "has_entries")).toBe(true);
    expect((await listReportingPeriods(db, EDITION)).some((period) => period.id === last.id)).toBe(true);
    expect(stored.periods.length).toBe(4);
  });
});

describe("previewReportingPeriods", () => {
  it("reports what a schedule change would do without writing anything", async () => {
    await ensureReportingPeriods(db, EDITION);
    await rows(`UPDATE hq_hackathons SET start_date='2026-09-21' WHERE id=$1`, [EDITION]);
    const preview = await previewReportingPeriods(db, EDITION);
    expect(preview.updated).toBeGreaterThan(0);
    expect((await listReportingPeriods(db, EDITION))[0].startDate).toBe("2026-09-14");
  });
});

describe("currentReportingPeriod", () => {
  it("picks the period an instant falls in, with an exclusive end", async () => {
    await ensureReportingPeriods(db, EDITION);
    expect((await currentReportingPeriod(db, EDITION, Date.parse("2026-09-18T09:00:00Z")))?.sequence).toBe(1);
    expect((await currentReportingPeriod(db, EDITION, Date.parse("2026-09-20T22:00:00Z")))?.sequence).toBe(2);
    expect(await currentReportingPeriod(db, EDITION, Date.parse("2026-10-12T22:00:00Z"))).toBeNull();
  });
});

describe("enableReporting", () => {
  it("puts an imported team into reporting and stores the edition's schedule with it", async () => {
    await seedImportedProject(PROJECT_A, "lead-a");
    const enabled = await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION });
    expect(enabled).toMatchObject({ ok: true, created: true });
    expect(await reportingEligibility(db, PROJECT_A)).toMatchObject({ projectId: PROJECT_A, hackathonId: EDITION, paused: false });
    // "Store period identities once reporting begins": the first team entering
    // reporting is what makes the edition's schedule exist.
    expect((await listReportingPeriods(db, EDITION)).length).toBe(4);
  });

  it("is idempotent and never moves an existing eligibility start", async () => {
    await seedImportedProject(PROJECT_A, "lead-a");
    await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION });
    const first = await reportingEligibility(db, PROJECT_A);
    const again = await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION, operatorId: OPERATOR_ID });
    expect(again).toMatchObject({ ok: true, created: false });
    expect((await reportingEligibility(db, PROJECT_A))?.eligibleFrom).toBe(first?.eligibleFrom);
  });

  it("enables a project an admin created directly, which has no imported team at all", async () => {
    await seedProject(BARE_PROJECT, EDITION, "CRM only");
    expect(await enableReporting(db, { projectId: BARE_PROJECT, hackathonId: EDITION, operatorId: OPERATOR_ID }))
      .toMatchObject({ ok: true, created: true });
    expect(await reportingEligibility(db, BARE_PROJECT)).toMatchObject({ projectId: BARE_PROJECT });
  });

  it("refuses a project from another edition and one that does not exist", async () => {
    await seedImportedProject(PROJECT_B, "lead-b", { hackathonId: OTHER_EDITION });
    expect(await enableReporting(db, { projectId: PROJECT_B, hackathonId: EDITION, operatorId: OPERATOR_ID }))
      .toEqual({ ok: false, reason: "not_found" });
    expect(await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION, operatorId: OPERATOR_ID }))
      .toEqual({ ok: false, reason: "not_found" });
  });

  it("resumes a paused project rather than restarting its eligibility", async () => {
    await seedImportedProject(PROJECT_A, "lead-a");
    await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION });
    const start = (await reportingEligibility(db, PROJECT_A))?.eligibleFrom;
    await pauseReporting(db, { projectId: PROJECT_A, hackathonId: EDITION, paused: true, operatorId: OPERATOR_ID });
    expect(await reportingEligibility(db, PROJECT_A)).toMatchObject({ paused: true });
    await pauseReporting(db, { projectId: PROJECT_A, hackathonId: EDITION, paused: false, operatorId: OPERATOR_ID });
    expect(await reportingEligibility(db, PROJECT_A)).toMatchObject({ paused: false, eligibleFrom: start });
  });

  it("records an audit event for an admin enabling or pausing a project, and none for the import's own", async () => {
    await seedImportedProject(PROJECT_A, "lead-a");
    await seedProject(BARE_PROJECT, EDITION, "CRM only");
    await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION });
    await enableReporting(db, { projectId: BARE_PROJECT, hackathonId: EDITION, operatorId: OPERATOR_ID });
    await pauseReporting(db, { projectId: BARE_PROJECT, hackathonId: EDITION, paused: true, operatorId: OPERATOR_ID });
    const events = await rows(`SELECT kind, actor_kind, project_id::text AS project_id, metadata FROM hq_audit_events ORDER BY id`);
    expect(events.map((row) => [row.kind, row.actor_kind, row.project_id])).toEqual([
      ["reporting.eligibility_changed", "operator", BARE_PROJECT],
      ["reporting.eligibility_changed", "operator", BARE_PROJECT],
    ]);
    expect(events[1].metadata).toMatchObject({ paused: true });
  });
});

describe("the Captain reduced-card gap", () => {
  it("gives a project with no imported team the same reporting record as one with", async () => {
    await seedProject(BARE_PROJECT, EDITION, "CRM only");
    await seedImportedProject(PROJECT_A, "lead-a", { name: "Imported" });
    await seedAssignedCaptain("cap", BARE_PROJECT);
    await enableReporting(db, { projectId: BARE_PROJECT, hackathonId: EDITION, operatorId: OPERATOR_ID });
    await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION });
    // Reporting is keyed on hq_projects, not on hq_project_onboarding, so
    // eligibility, periods and status exist for both alike; what the CRM-only
    // project lacks is roster and Colosseum detail, which reporting never
    // needed.
    expect(await reportingEligibility(db, BARE_PROJECT)).toMatchObject({ projectId: BARE_PROJECT, imported: false, projectName: "CRM only" });
    expect(await reportingEligibility(db, PROJECT_A)).toMatchObject({ projectId: PROJECT_A, imported: true, projectName: "Imported" });
  });
});

describe("createUpdate", () => {
  beforeEach(async () => {
    await seedImportedProject(PROJECT_A, "lead-a", { members: ["member-a"] });
    await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION });
  });

  const WEEK_ONE = Date.parse("2026-09-16T09:00:00Z");

  it("saves a team member's update into the open period and completes it", async () => {
    const result = await createUpdate(member("member-a"), {
      projectId: PROJECT_A, hackathonId: EDITION, body: "  Shipped the importer  ", atMs: WEEK_ONE,
    });
    expect(result).toMatchObject({ ok: true, completesPeriod: true });
    if (!result.ok) throw new Error("expected a saved update");
    expect(result.entry).toMatchObject({ body: "Shipped the importer", visibility: "shared", version: 1, late: false, edited: false, source: "hq" });
    expect(result.period.sequence).toBe(1);
    // The initial submitted version is a revision of its own.
    expect(await rows(`SELECT version, body, editor_kind, editor_id FROM hq_reporting_entry_revisions WHERE entry_id=$1`, [result.entry.id]))
      .toEqual([{ version: 1, body: "Shipped the importer", editor_kind: "member", editor_id: "member-a" }]);
  });

  it("uses the server's own clock for the submitted timestamp, never a caller's", async () => {
    const before = Date.now();
    const result = await createUpdate(member("lead-a"), { projectId: PROJECT_A, hackathonId: EDITION, body: "Week one", atMs: WEEK_ONE });
    if (!result.ok) throw new Error("expected a saved update");
    expect(Date.parse(result.entry.submittedAt)).toBeGreaterThanOrEqual(before);
  });

  it("refuses an empty body and one over the maximum, and saves neither", async () => {
    expect(await createUpdate(member("lead-a"), { projectId: PROJECT_A, hackathonId: EDITION, body: "   ", atMs: WEEK_ONE })).toEqual({ ok: false, reason: "empty_body" });
    expect(await createUpdate(member("lead-a"), { projectId: PROJECT_A, hackathonId: EDITION, body: "x".repeat(4001), atMs: WEEK_ONE })).toEqual({ ok: false, reason: "body_too_long" });
    expect(await rows(`SELECT count(*)::int AS n FROM hq_reporting_entries`)).toEqual([{ n: 0 }]);
  });

  it("refuses an account with no relationship to the team, and tells it nothing about the project", async () => {
    await seedAccount("stranger");
    expect(await createUpdate(member("stranger"), { projectId: PROJECT_A, hackathonId: EDITION, body: "Hello", atMs: WEEK_ONE }))
      .toEqual({ ok: false, reason: "not_authorized" });
  });

  it("refuses a project that is not in reporting at all", async () => {
    await seedImportedProject(PROJECT_B, "lead-b");
    expect(await createUpdate(member("lead-b"), { projectId: PROJECT_B, hackathonId: EDITION, body: "Hello", atMs: WEEK_ONE }))
      .toEqual({ ok: false, reason: "not_eligible" });
  });

  it("refuses a save outside the campaign, when no period is open", async () => {
    expect(await createUpdate(member("lead-a"), { projectId: PROJECT_A, hackathonId: EDITION, body: "Too early", atMs: Date.parse("2026-09-01T09:00:00Z") }))
      .toEqual({ ok: false, reason: "no_open_period" });
  });

  it("refuses to move an expired draft to a new week on its own", async () => {
    const periods = await listReportingPeriods(db, EDITION);
    const result = await createUpdate(member("lead-a"), {
      projectId: PROJECT_A, hackathonId: EDITION, body: "Written last night",
      expectedPeriodId: periods[0].id, atMs: Date.parse("2026-09-21T09:00:00Z"),
    });
    expect(result).toMatchObject({ ok: false, reason: "period_changed" });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.currentPeriod?.sequence).toBe(2);
    expect(await rows(`SELECT count(*)::int AS n FROM hq_reporting_entries`)).toEqual([{ n: 0 }]);
  });

  it("saves a draft whose bound period is still the open one", async () => {
    const periods = await listReportingPeriods(db, EDITION);
    expect(await createUpdate(member("lead-a"), {
      projectId: PROJECT_A, hackathonId: EDITION, body: "Still this week", expectedPeriodId: periods[0].id, atMs: WEEK_ONE,
    })).toMatchObject({ ok: true });
  });

  it("marks an entry explicitly added to a period that has already passed as late, and does not complete it", async () => {
    const periods = await listReportingPeriods(db, EDITION);
    const result = await createUpdate(member("lead-a"), {
      projectId: PROJECT_A, hackathonId: EDITION, body: "Sorry, forgot", periodId: periods[0].id, atMs: Date.parse("2026-09-24T09:00:00Z"),
    });
    expect(result).toMatchObject({ ok: true, completesPeriod: false });
    if (!result.ok) throw new Error("expected a saved update");
    expect(result.entry.late).toBe(true);
  });

  it("refuses a period from another edition", async () => {
    await ensureReportingPeriods(db, OTHER_EDITION);
    const other = await listReportingPeriods(db, OTHER_EDITION);
    expect(await createUpdate(member("lead-a"), { projectId: PROJECT_A, hackathonId: EDITION, body: "Wrong edition", periodId: other[0].id, atMs: WEEK_ONE }))
      .toEqual({ ok: false, reason: "period_not_found" });
  });

  it("lets the assigned Captain write a sensitive note, and the team never can", async () => {
    await seedAssignedCaptain("cap", PROJECT_A);
    expect(await createUpdate(member("cap", ["captain"]), {
      projectId: PROJECT_A, hackathonId: EDITION, body: "Struggling with the lead", visibility: "sensitive", atMs: WEEK_ONE,
    })).toMatchObject({ ok: true, completesPeriod: true });
    expect(await createUpdate(member("lead-a"), { projectId: PROJECT_A, hackathonId: EDITION, body: "Hidden from my team", visibility: "sensitive", atMs: WEEK_ONE }))
      .toEqual({ ok: false, reason: "visibility_not_allowed" });
  });

  it("refuses a Captain elsewhere the sensitive option on their own team", async () => {
    await seedImportedProject(PROJECT_B, "lead-b");
    await seedAccount("lead-a");
    await grantCapability(db, { actor: { kind: "operator", id: OPERATOR_ID }, byOperatorId: OPERATOR_ID, userId: "lead-a", capability: "captain", reason: "test" });
    await assignCaptain(db, { actorOperatorId: OPERATOR_ID, projectId: PROJECT_B, hackathonId: EDITION, captainUserId: "lead-a" });
    expect(await createUpdate(member("lead-a", ["captain"]), {
      projectId: PROJECT_A, hackathonId: EDITION, body: "Hidden from my own teammates", visibility: "sensitive", atMs: WEEK_ONE,
    })).toEqual({ ok: false, reason: "visibility_not_allowed" });
  });

  it("lets an admin add an update on the team's behalf, preserving the operator as its author", async () => {
    const result = await createUpdate(OPERATOR, { projectId: PROJECT_A, hackathonId: EDITION, body: "Recorded from the call", atMs: WEEK_ONE });
    expect(result).toMatchObject({ ok: true });
    expect(await rows(`SELECT author_kind, author_id FROM hq_reporting_entries`)).toEqual([{ author_kind: "operator", author_id: OPERATOR_ID }]);
  });

  it("does not let a second entry create a second completion", async () => {
    await createUpdate(member("lead-a"), { projectId: PROJECT_A, hackathonId: EDITION, body: "First", atMs: WEEK_ONE });
    const second = await createUpdate(member("member-a"), { projectId: PROJECT_A, hackathonId: EDITION, body: "Second", atMs: WEEK_ONE });
    expect(second).toMatchObject({ ok: true, completesPeriod: true });
    expect(await rows(`SELECT count(*)::int AS n FROM hq_reporting_entries`)).toEqual([{ n: 2 }]);
    const status = await reportingStatus(db, { hackathonId: EDITION, atMs: WEEK_ONE });
    expect(status.find((row) => row.projectId === PROJECT_A)?.current).toMatchObject({ completed: true, entries: 2 });
  });
});

describe("editUpdate", () => {
  const WEEK_ONE = Date.parse("2026-09-16T09:00:00Z");
  let entryId: string;

  beforeEach(async () => {
    await seedImportedProject(PROJECT_A, "lead-a", { members: ["member-a"] });
    await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION });
    const created = await createUpdate(member("member-a"), { projectId: PROJECT_A, hackathonId: EDITION, body: "First draft", atMs: WEEK_ONE });
    if (!created.ok) throw new Error("setup: expected a saved update");
    entryId = created.entry.id;
  });

  it("appends a revision per version and leaves the original submission timestamp alone", async () => {
    const before = await rows(`SELECT submitted_at, period_id::text AS period_id FROM hq_reporting_entries WHERE id=$1`, [entryId]);
    const edited = await editUpdate(member("member-a"), { entryId, body: "Second draft", expectedVersion: 1 });
    expect(edited).toMatchObject({ ok: true, changed: true });
    if (!edited.ok) throw new Error("expected an edit");
    expect(edited.entry).toMatchObject({ version: 2, body: "Second draft", edited: true });
    expect(await rows(`SELECT version, body FROM hq_reporting_entry_revisions WHERE entry_id=$1 ORDER BY version`, [entryId]))
      .toEqual([{ version: 1, body: "First draft" }, { version: 2, body: "Second draft" }]);
    expect(await rows(`SELECT submitted_at, period_id::text AS period_id FROM hq_reporting_entries WHERE id=$1`, [entryId])).toEqual(before);
  });

  it("refuses an edit whose expected version is stale, and hands back the current entry so the unsaved text survives", async () => {
    await editUpdate(member("member-a"), { entryId, body: "From the website", expectedVersion: 1 });
    const conflict = await editUpdate(member("member-a"), { entryId, body: "From Telegram", expectedVersion: 1 });
    expect(conflict).toMatchObject({ ok: false, reason: "conflict" });
    if (conflict.ok) throw new Error("expected a conflict");
    expect(conflict.current).toMatchObject({ version: 2, body: "From the website" });
    expect(await rows(`SELECT count(*)::int AS n FROM hq_reporting_entry_revisions WHERE entry_id=$1`, [entryId])).toEqual([{ n: 2 }]);
  });

  it("skips a no-op save rather than growing the history", async () => {
    const unchanged = await editUpdate(member("member-a"), { entryId, body: "First draft", expectedVersion: 1 });
    expect(unchanged).toMatchObject({ ok: true, changed: false });
    expect(await rows(`SELECT count(*)::int AS n FROM hq_reporting_entry_revisions WHERE entry_id=$1`, [entryId])).toEqual([{ n: 1 }]);
  });

  it("refuses a teammate editing someone else's entry, while the team can still read it", async () => {
    expect(await editUpdate(member("lead-a"), { entryId, body: "Not mine to change", expectedVersion: 1 }))
      .toEqual({ ok: false, reason: "not_authorized" });
  });

  it("lets an admin correct any entry while the original author is preserved", async () => {
    const edited = await editUpdate(OPERATOR, { entryId, body: "Corrected by an admin", expectedVersion: 1 });
    expect(edited).toMatchObject({ ok: true });
    expect(await rows(`SELECT author_kind, author_id FROM hq_reporting_entries WHERE id=$1`, [entryId]))
      .toEqual([{ author_kind: "member", author_id: "member-a" }]);
    expect(await rows(`SELECT editor_kind, editor_id FROM hq_reporting_entry_revisions WHERE entry_id=$1 AND version=2`, [entryId]))
      .toEqual([{ editor_kind: "operator", editor_id: OPERATOR_ID }]);
  });

  it("requires the new audience to be confirmed before a sensitive note becomes shared", async () => {
    await seedAssignedCaptain("cap", PROJECT_A);
    const note = await createUpdate(member("cap", ["captain"]), {
      projectId: PROJECT_A, hackathonId: EDITION, body: "A private note", visibility: "sensitive", atMs: WEEK_ONE,
    });
    if (!note.ok) throw new Error("setup: expected a saved note");
    expect(await editUpdate(member("cap", ["captain"]), { entryId: note.entry.id, visibility: "shared", expectedVersion: 1 }))
      .toEqual({ ok: false, reason: "audience_not_confirmed" });
    expect(await editUpdate(member("cap", ["captain"]), { entryId: note.entry.id, visibility: "shared", expectedVersion: 1, confirmAudienceChange: true }))
      .toMatchObject({ ok: true, entry: expect.objectContaining({ visibility: "shared" }) });
  });

  it("refuses a team member turning their own entry sensitive after the fact", async () => {
    expect(await editUpdate(member("member-a"), { entryId, visibility: "sensitive", expectedVersion: 1 }))
      .toEqual({ ok: false, reason: "visibility_not_allowed" });
  });

  it("refuses an empty body, one over the maximum, and an unknown entry", async () => {
    expect(await editUpdate(member("member-a"), { entryId, body: "  ", expectedVersion: 1 })).toEqual({ ok: false, reason: "empty_body" });
    expect(await editUpdate(member("member-a"), { entryId, body: "x".repeat(4001), expectedVersion: 1 })).toEqual({ ok: false, reason: "body_too_long" });
    expect(await editUpdate(member("member-a"), { entryId: PROJECT_B, body: "Nothing here", expectedVersion: 1 })).toEqual({ ok: false, reason: "not_found" });
  });

  it("never completes the current week by editing an older one", async () => {
    const later = Date.parse("2026-09-24T09:00:00Z");
    await editUpdate(member("member-a"), { entryId, body: "Touched up in week two", expectedVersion: 1 });
    const status = await reportingStatus(db, { hackathonId: EDITION, atMs: later });
    expect(status.find((row) => row.projectId === PROJECT_A)?.current).toMatchObject({ periodSequence: 2, completed: false });
  });
});

describe("voidUpdate", () => {
  const WEEK_ONE = Date.parse("2026-09-16T09:00:00Z");
  let entryId: string;

  beforeEach(async () => {
    await seedImportedProject(PROJECT_A, "lead-a");
    await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION });
    const created = await createUpdate(member("lead-a"), { projectId: PROJECT_A, hackathonId: EDITION, body: "Spam", atMs: WEEK_ONE });
    if (!created.ok) throw new Error("setup: expected a saved update");
    entryId = created.entry.id;
  });

  it("is admin only and keeps the row, its body and its revisions", async () => {
    expect(await voidUpdate(member("lead-a"), { entryId, reason: "I want it gone" })).toEqual({ ok: false, reason: "not_authorized" });
    expect(await voidUpdate(OPERATOR, { entryId, reason: "Off topic" })).toMatchObject({ ok: true });
    expect(await rows(`SELECT body, voided_at IS NOT NULL AS voided, void_reason FROM hq_reporting_entries WHERE id=$1`, [entryId]))
      .toEqual([{ body: "Spam", voided: true, void_reason: "Off topic" }]);
    expect(await rows(`SELECT count(*)::int AS n FROM hq_reporting_entry_revisions WHERE entry_id=$1`, [entryId])).toEqual([{ n: 1 }]);
  });

  it("reopens the period it was completing, and records the reason without the body", async () => {
    await voidUpdate(OPERATOR, { entryId, reason: "Off topic" });
    const status = await reportingStatus(db, { hackathonId: EDITION, atMs: WEEK_ONE });
    expect(status.find((row) => row.projectId === PROJECT_A)?.current).toMatchObject({ completed: false, entries: 0 });
    const [event] = await rows(`SELECT kind, metadata FROM hq_audit_events WHERE kind='reporting.entry_voided'`);
    expect(event.metadata).toMatchObject({ entryId, reason: "Off topic" });
    expect(JSON.stringify(event.metadata)).not.toContain("Spam");
  });

  it("refuses to edit a voided entry", async () => {
    await voidUpdate(OPERATOR, { entryId, reason: "Off topic" });
    expect(await editUpdate(OPERATOR, { entryId, body: "Put it back", expectedVersion: 1 })).toEqual({ ok: false, reason: "voided" });
  });
});

describe("readAuthorizedUpdates", () => {
  const WEEK_ONE = Date.parse("2026-09-16T09:00:00Z");

  beforeEach(async () => {
    await seedImportedProject(PROJECT_A, "lead-a", { members: ["member-a"] });
    await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION });
    await seedAssignedCaptain("cap", PROJECT_A);
    await createUpdate(member("lead-a"), { projectId: PROJECT_A, hackathonId: EDITION, body: "Team update", atMs: WEEK_ONE });
    await createUpdate(member("cap", ["captain"]), { projectId: PROJECT_A, hackathonId: EDITION, body: "Shared Captain note", atMs: WEEK_ONE });
    await createUpdate(member("cap", ["captain"]), { projectId: PROJECT_A, hackathonId: EDITION, body: "SENSITIVE-BODY", visibility: "sensitive", atMs: WEEK_ONE });
  });

  const bodies = (page: { entries: { body: string }[] }) => page.entries.map((entry) => entry.body);

  it("shows the team its own updates and the shared Captain note, and nothing of the sensitive one", async () => {
    const page = await readAuthorizedUpdates(member("member-a"), { projectId: PROJECT_A, hackathonId: EDITION });
    expect(bodies(page).sort()).toEqual(["Shared Captain note", "Team update"]);
    expect(JSON.stringify(page)).not.toContain("SENSITIVE");
  });

  it("shows the sensitive note to its author and to an admin", async () => {
    expect(bodies(await readAuthorizedUpdates(member("cap", ["captain"]), { projectId: PROJECT_A, hackathonId: EDITION }))).toContain("SENSITIVE-BODY");
    expect(bodies(await readAuthorizedUpdates(OPERATOR, { projectId: PROJECT_A, hackathonId: EDITION }))).toContain("SENSITIVE-BODY");
  });

  it("shows another Captain nothing at all, not even that the project exists", async () => {
    await seedAccount("cap2");
    await grantCapability(db, { actor: { kind: "operator", id: OPERATOR_ID }, byOperatorId: OPERATOR_ID, userId: "cap2", capability: "captain", reason: "test" });
    expect(await readAuthorizedUpdates(member("cap2", ["captain"]), { projectId: PROJECT_A, hackathonId: EDITION })).toEqual({ entries: [], nextCursor: null });
  });

  it("keeps the sensitive note out of the team's view after it is made shared, and only from that version on", async () => {
    const admin = await readAuthorizedUpdates(OPERATOR, { projectId: PROJECT_A, hackathonId: EDITION });
    const note = admin.entries.find((entry) => entry.body === "SENSITIVE-BODY");
    if (!note) throw new Error("setup: expected the sensitive note");
    await editUpdate(member("cap", ["captain"]), { entryId: note.id, body: "Now shared", visibility: "shared", expectedVersion: 1, confirmAudienceChange: true });
    const team = await readAuthorizedUpdates(member("member-a"), { projectId: PROJECT_A, hackathonId: EDITION });
    expect(bodies(team)).toContain("Now shared");
    // The prior revision is still the old, restricted text, and no member reader can reach it.
    expect(JSON.stringify(team)).not.toContain("SENSITIVE-BODY");
    expect(await readRevisionHistory(member("cap", ["captain"]), { entryId: note.id })).toEqual([]);
    expect((await readRevisionHistory(OPERATOR, { entryId: note.id })).map((revision) => revision.body)).toEqual(["SENSITIVE-BODY", "Now shared"]);
  });

  it("marks what the viewer may edit and never returns a revision body in a list", async () => {
    const page = await readAuthorizedUpdates(member("lead-a"), { projectId: PROJECT_A, hackathonId: EDITION });
    expect(page.entries.map((entry) => [entry.body, entry.canEdit]).sort()).toEqual([["Shared Captain note", false], ["Team update", true]]);
    expect(page.entries.every((entry) => !("revisions" in entry))).toBe(true);
  });

  it("hides a voided entry from the team and shows it to an admin, marked", async () => {
    const admin = await readAuthorizedUpdates(OPERATOR, { projectId: PROJECT_A, hackathonId: EDITION });
    const team = admin.entries.find((entry) => entry.body === "Team update");
    if (!team) throw new Error("setup: expected the team update");
    await voidUpdate(OPERATOR, { entryId: team.id, reason: "Duplicate" });
    expect(bodies(await readAuthorizedUpdates(member("member-a"), { projectId: PROJECT_A, hackathonId: EDITION }))).not.toContain("Team update");
    expect((await readAuthorizedUpdates(OPERATOR, { projectId: PROJECT_A, hackathonId: EDITION })).entries.find((entry) => entry.body === "Team update")?.voided).toBe(true);
  });

  it("pages newest first without shifting under a later insert", async () => {
    const first = await readAuthorizedUpdates(OPERATOR, { projectId: PROJECT_A, hackathonId: EDITION, limit: 2 });
    expect(first.entries.length).toBe(2);
    expect(first.nextCursor).not.toBe(null);
    await createUpdate(member("lead-a"), { projectId: PROJECT_A, hackathonId: EDITION, body: "Newest", atMs: WEEK_ONE });
    const second = await readAuthorizedUpdates(OPERATOR, { projectId: PROJECT_A, hackathonId: EDITION, limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.entries.map((entry) => entry.id)).not.toContain(first.entries[0].id);
    expect(bodies(second)).not.toContain("Newest");
  });

  it("filters to one period when asked", async () => {
    const periods = await listReportingPeriods(db, EDITION);
    expect((await readAuthorizedUpdates(OPERATOR, { projectId: PROJECT_A, hackathonId: EDITION, periodId: periods[1].id })).entries).toEqual([]);
    expect((await readAuthorizedUpdates(OPERATOR, { projectId: PROJECT_A, hackathonId: EDITION, periodId: periods[0].id })).entries.length).toBe(3);
  });
});

describe("readRevisionHistory", () => {
  it("is admin only, whoever wrote the entry", async () => {
    await seedImportedProject(PROJECT_A, "lead-a");
    await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION });
    const created = await createUpdate(member("lead-a"), { projectId: PROJECT_A, hackathonId: EDITION, body: "v1", atMs: Date.parse("2026-09-16T09:00:00Z") });
    if (!created.ok) throw new Error("setup: expected a saved update");
    await editUpdate(member("lead-a"), { entryId: created.entry.id, body: "v2", expectedVersion: 1 });
    expect(await readRevisionHistory(member("lead-a"), { entryId: created.entry.id })).toEqual([]);
    const history = await readRevisionHistory(OPERATOR, { entryId: created.entry.id });
    expect(history.map((revision) => [revision.version, revision.body, revision.editorId])).toEqual([[1, "v1", "lead-a"], [2, "v2", "lead-a"]]);
  });
});

describe("reportingStatus", () => {
  const WEEK_ONE = Date.parse("2026-09-16T09:00:00Z");
  const WEEK_TWO = Date.parse("2026-09-23T09:00:00Z");

  beforeEach(async () => {
    await seedImportedProject(PROJECT_A, "lead-a", { name: "Reported" });
    await seedImportedProject(PROJECT_B, "lead-b", { name: "Silent" });
    await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION });
    await enableReporting(db, { projectId: PROJECT_B, hackathonId: EDITION });
  });

  const of = (statuses: Awaited<ReturnType<typeof reportingStatus>>, projectId: string) => {
    const row = statuses.find((candidate) => candidate.projectId === projectId);
    if (!row) throw new Error(`no status for ${projectId}`);
    return row;
  };

  it("reads every project in one grouped pass, naming the open period and its deadline", async () => {
    await createUpdate(member("lead-a"), { projectId: PROJECT_A, hackathonId: EDITION, body: "Done", atMs: WEEK_ONE });
    const statuses = await reportingStatus(db, { hackathonId: EDITION, atMs: WEEK_ONE });
    expect(of(statuses, PROJECT_A).current).toMatchObject({ periodSequence: 1, completed: true, basis: "entry", entries: 1, endsAt: "2026-09-20T22:00:00.000Z" });
    expect(of(statuses, PROJECT_B).current).toMatchObject({ periodSequence: 1, completed: false, basis: "none", entries: 0 });
  });

  it("counts a missed week the moment the period has ended, before any closure job has run", async () => {
    await createUpdate(member("lead-a"), { projectId: PROJECT_A, hackathonId: EDITION, body: "Done", atMs: WEEK_ONE });
    const statuses = await reportingStatus(db, { hackathonId: EDITION, atMs: WEEK_TWO });
    expect(of(statuses, PROJECT_A).missedPeriods).toBe(0);
    expect(of(statuses, PROJECT_B).missedPeriods).toBe(1);
  });

  it("does not let a late entry complete a week that has already passed, closed or not", async () => {
    // The period has ended but no closure job has run, so the answer comes
    // from the live rule rather than from a stored outcome.
    await createUpdate(member("lead-a"), { projectId: PROJECT_A, hackathonId: EDITION, body: "Sorry, forgot", periodId: (await listReportingPeriods(db, EDITION))[0].id, atMs: WEEK_TWO });
    const statuses = await reportingStatus(db, { hackathonId: EDITION, atMs: WEEK_TWO, includeHistory: true });
    expect(of(statuses, PROJECT_A).history[0]).toMatchObject({ completed: false, basis: "none", entries: 0, closed: false });
    expect(of(statuses, PROJECT_A).missedPeriods).toBe(1);
  });

  it("fabricates no missed week before a project entered reporting", async () => {
    await rows(`UPDATE hq_reporting_eligibility SET eligible_from='2026-09-22T08:00:00Z' WHERE project_id=$1`, [PROJECT_B]);
    expect(of(await reportingStatus(db, { hackathonId: EDITION, atMs: WEEK_TWO }), PROJECT_B))
      .toMatchObject({ missedPeriods: 0, current: expect.objectContaining({ periodSequence: 2 }) });
  });

  it("stops counting missed weeks for a paused project without touching what it already recorded", async () => {
    await pauseReporting(db, { projectId: PROJECT_B, hackathonId: EDITION, paused: true, operatorId: OPERATOR_ID });
    await rows(`UPDATE hq_reporting_eligibility SET paused_at='2026-09-15T08:00:00Z' WHERE project_id=$1`, [PROJECT_B]);
    expect(of(await reportingStatus(db, { hackathonId: EDITION, atMs: WEEK_TWO }), PROJECT_B)).toMatchObject({ paused: true, missedPeriods: 0 });
  });

  it("lets a confirmed, on-time Colosseum submission satisfy the final period and no earlier one", async () => {
    await rows(`UPDATE hq_project_onboarding SET submission_status='submitted', submitted_at='2026-10-02T10:00:00Z' WHERE project_id=$1`, [PROJECT_A]);
    const statuses = await reportingStatus(db, { hackathonId: EDITION, atMs: Date.parse("2026-10-07T09:00:00Z"), includeHistory: true });
    const project = of(statuses, PROJECT_A);
    expect(project.current).toMatchObject({ periodSequence: 4, mode: "submission", completed: true, basis: "submission" });
    // Submitting does not retroactively complete the weekly periods it missed.
    expect(project.history.slice(0, 3).map((period) => period.completed)).toEqual([false, false, false]);
    expect(project.missedPeriods).toBe(3);
  });

  it("does not let a submission after the official deadline satisfy the final period", async () => {
    await rows(`UPDATE hq_reporting_config SET official_submission_deadline='2026-10-10T20:00:00Z' WHERE hackathon_id=$1`, [EDITION]);
    await rows(`UPDATE hq_project_onboarding SET submission_status='submitted', submitted_at='2026-10-11T10:00:00Z' WHERE project_id=$1`, [PROJECT_A]);
    expect(of(await reportingStatus(db, { hackathonId: EDITION, atMs: Date.parse("2026-10-12T09:00:00Z") }), PROJECT_A).current)
      .toMatchObject({ completed: false, basis: "none" });
  });

  it("gives a CRM-only project the same status row as an imported one", async () => {
    await seedProject(BARE_PROJECT, EDITION, "CRM only");
    await enableReporting(db, { projectId: BARE_PROJECT, hackathonId: EDITION, operatorId: OPERATOR_ID });
    expect(of(await reportingStatus(db, { hackathonId: EDITION, atMs: WEEK_ONE }), BARE_PROJECT)).toMatchObject({
      projectName: "CRM only", imported: false, submissionStatus: "not_checked",
      current: expect.objectContaining({ periodSequence: 1, completed: false }),
    });
  });

  it("narrows to the projects asked for, and answers nothing for a project not in reporting", async () => {
    expect((await reportingStatus(db, { hackathonId: EDITION, projectIds: [PROJECT_A], atMs: WEEK_ONE })).map((row) => row.projectId)).toEqual([PROJECT_A]);
    expect(await reportingStatus(db, { hackathonId: EDITION, projectIds: [BARE_PROJECT], atMs: WEEK_ONE })).toEqual([]);
  });

  it("names the current Captain of each project", async () => {
    await seedAssignedCaptain("cap", PROJECT_A);
    const statuses = await reportingStatus(db, { hackathonId: EDITION, atMs: WEEK_ONE });
    expect(of(statuses, PROJECT_A).captainUserId).toBe("cap");
    expect(of(statuses, PROJECT_B).captainUserId).toBe(null);
  });
});

describe("closePeriod", () => {
  const WEEK_ONE = Date.parse("2026-09-16T09:00:00Z");
  const AFTER_WEEK_ONE = Date.parse("2026-09-21T09:00:00Z");
  let periodOne: string;

  beforeEach(async () => {
    await seedImportedProject(PROJECT_A, "lead-a", { name: "Reported" });
    await seedImportedProject(PROJECT_B, "lead-b", { name: "Silent" });
    await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION });
    await enableReporting(db, { projectId: PROJECT_B, hackathonId: EDITION });
    periodOne = (await listReportingPeriods(db, EDITION))[0].id;
  });

  it("refuses to close a period that has not ended", async () => {
    expect(await closePeriod(db, { periodId: periodOne, actor: OPERATOR, atMs: WEEK_ONE })).toEqual({ ok: false, reason: "not_ended" });
  });

  it("records one outcome per accountable project, with the Captain at close", async () => {
    await seedAssignedCaptain("cap", PROJECT_A);
    await createUpdate(member("lead-a"), { projectId: PROJECT_A, hackathonId: EDITION, body: "Week one", atMs: WEEK_ONE });
    const closed = await closePeriod(db, { periodId: periodOne, actor: OPERATOR, atMs: AFTER_WEEK_ONE });
    expect(closed).toMatchObject({ ok: true, alreadyClosed: false, completed: 1, missed: 1 });
    if (!closed.ok) throw new Error("expected a close");
    expect(closed.outcomes.map((outcome) => [outcome.projectId, outcome.completed, outcome.basis, outcome.captainUserId]).sort()).toEqual([
      [PROJECT_A, true, "entry", "cap"],
      [PROJECT_B, false, "none", null],
    ]);
    expect((await listReportingPeriods(db, EDITION))[0].closedAt).not.toBe(null);
  });

  it("is idempotent, and a second close never rewrites what the first recorded", async () => {
    await closePeriod(db, { periodId: periodOne, actor: OPERATOR, atMs: AFTER_WEEK_ONE });
    await createUpdate(member("lead-a"), { projectId: PROJECT_A, hackathonId: EDITION, body: "Late", periodId: periodOne, atMs: AFTER_WEEK_ONE });
    const again = await closePeriod(db, { periodId: periodOne, actor: OPERATOR, atMs: AFTER_WEEK_ONE });
    expect(again).toMatchObject({ ok: true, alreadyClosed: true, completed: 0, missed: 2 });
  });

  it("keeps the missed outcome after a late entry is added, and marks the entry late", async () => {
    await closePeriod(db, { periodId: periodOne, actor: OPERATOR, atMs: AFTER_WEEK_ONE });
    const late = await createUpdate(member("lead-a"), { projectId: PROJECT_A, hackathonId: EDITION, body: "Sorry", periodId: periodOne, atMs: AFTER_WEEK_ONE });
    expect(late).toMatchObject({ ok: true, completesPeriod: false });
    const status = await reportingStatus(db, { hackathonId: EDITION, atMs: AFTER_WEEK_ONE, includeHistory: true });
    const project = status.find((row) => row.projectId === PROJECT_A);
    expect(project?.history[0]).toMatchObject({ completed: false, closed: true });
    expect(project?.missedPeriods).toBe(1);
  });

  it("leaves out a project that had not entered reporting by the period's end", async () => {
    await rows(`UPDATE hq_reporting_eligibility SET eligible_from='2026-09-22T08:00:00Z' WHERE project_id=$1`, [PROJECT_B]);
    const closed = await closePeriod(db, { periodId: periodOne, actor: OPERATOR, atMs: AFTER_WEEK_ONE });
    if (!closed.ok) throw new Error("expected a close");
    expect(closed.outcomes.map((outcome) => outcome.projectId)).toEqual([PROJECT_A]);
  });

  it("audits the close as a system-attributable event carrying counts and no bodies", async () => {
    await createUpdate(member("lead-a"), { projectId: PROJECT_A, hackathonId: EDITION, body: "A private detail", atMs: WEEK_ONE });
    await closePeriod(db, { periodId: periodOne, actor: { kind: "job", audience: "hq-reporting" }, atMs: AFTER_WEEK_ONE });
    const [event] = await rows(`SELECT actor_kind, actor_id, metadata FROM hq_audit_events WHERE kind='reporting.period_closed'`);
    expect(event).toMatchObject({ actor_kind: "system", actor_id: null });
    expect(event.metadata).toMatchObject({ sequence: 1, projects: 2, completed: 1, missed: 1 });
    expect(JSON.stringify(event.metadata)).not.toContain("private detail");
  });

  it("refuses an unknown or malformed period", async () => {
    expect(await closePeriod(db, { periodId: PROJECT_A, actor: OPERATOR, atMs: AFTER_WEEK_ONE })).toEqual({ ok: false, reason: "not_found" });
    expect(await closePeriod(db, { periodId: "not-a-uuid", actor: OPERATOR, atMs: AFTER_WEEK_ONE })).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("correctOutcome", () => {
  const AFTER_WEEK_ONE = Date.parse("2026-09-21T09:00:00Z");
  let periodOne: string;

  beforeEach(async () => {
    await seedImportedProject(PROJECT_A, "lead-a");
    await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION });
    periodOne = (await listReportingPeriods(db, EDITION))[0].id;
    await closePeriod(db, { periodId: periodOne, actor: OPERATOR, atMs: AFTER_WEEK_ONE });
  });

  it("is admin only and requires a reason", async () => {
    expect(await correctOutcome(member("lead-a"), { periodId: periodOne, projectId: PROJECT_A, completed: true, reason: "we did report", operatorId: OPERATOR_ID }))
      .toEqual({ ok: false, reason: "not_authorized" });
    expect(await correctOutcome(OPERATOR, { periodId: periodOne, projectId: PROJECT_A, completed: true, reason: "   ", operatorId: OPERATOR_ID }))
      .toEqual({ ok: false, reason: "reason_required" });
  });

  it("writes the correction beside the original outcome and audits it", async () => {
    const corrected = await correctOutcome(OPERATOR, { periodId: periodOne, projectId: PROJECT_A, completed: true, reason: "Reported in the group chat", operatorId: OPERATOR_ID });
    expect(corrected).toMatchObject({ ok: true, outcome: expect.objectContaining({ completed: false, correctedCompleted: true, correctionReason: "Reported in the group chat" }) });
    const status = await reportingStatus(db, { hackathonId: EDITION, atMs: AFTER_WEEK_ONE, includeHistory: true });
    expect(status[0].history[0].completed).toBe(true);
    expect(status[0].missedPeriods).toBe(0);
    const [event] = await rows(`SELECT metadata FROM hq_audit_events WHERE kind='reporting.outcome_corrected'`);
    expect(event.metadata).toMatchObject({ originalCompleted: false, correctedCompleted: true, reason: "Reported in the group chat" });
  });

  it("refuses a correction that changes nothing and one for an outcome that does not exist", async () => {
    expect(await correctOutcome(OPERATOR, { periodId: periodOne, projectId: PROJECT_A, completed: false, reason: "no change", operatorId: OPERATOR_ID }))
      .toEqual({ ok: false, reason: "unchanged" });
    expect(await correctOutcome(OPERATOR, { periodId: periodOne, projectId: PROJECT_B, completed: true, reason: "nothing here", operatorId: OPERATOR_ID }))
      .toEqual({ ok: false, reason: "not_found" });
  });
});

describe("record deletion, extended for the reporting tables", () => {
  const WEEK_ONE = Date.parse("2026-09-16T09:00:00Z");
  const AFTER_WEEK_ONE = Date.parse("2026-09-21T09:00:00Z");

  async function seedReportedTeam() {
    await seedImportedProject(PROJECT_A, "lead-a", { name: "Reported" });
    await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION });
    const created = await createUpdate(member("lead-a"), { projectId: PROJECT_A, hackathonId: EDITION, body: "Week one", atMs: WEEK_ONE });
    if (!created.ok) throw new Error("setup: expected a saved update");
    await editUpdate(member("lead-a"), { entryId: created.entry.id, body: "Week one, corrected", expectedVersion: 1 });
    await closePeriod(db, { periodId: (await listReportingPeriods(db, EDITION))[0].id, actor: OPERATOR, atMs: AFTER_WEEK_ONE });
  }

  it("counts the reporting rows a team deletion would take with it", async () => {
    await seedReportedTeam();
    expect(await teamRemovalImpact(db, PROJECT_A)).toMatchObject({
      name: "Reported", reportingEnrolled: true, reportingEntries: 1, reportingRevisions: 2, reportingOutcomes: 1,
    });
  });

  it("removes every reporting row with the team, in the deletion's own transaction", async () => {
    await seedReportedTeam();
    expect(await deleteTeamRecord(db, { projectId: PROJECT_A, hackathonId: EDITION, operatorId: OPERATOR_ID }))
      .toMatchObject({ reportingEntries: 1, reportingOutcomes: 1 });
    for (const table of ["hq_reporting_entries", "hq_reporting_entry_revisions", "hq_reporting_eligibility", "hq_reporting_outcomes"]) {
      expect(await rows(`SELECT count(*)::int AS n FROM ${table}`), table).toEqual([{ n: 0 }]);
    }
    // The edition's periods are not the team's to take: another team still reports against them.
    expect((await listReportingPeriods(db, EDITION)).length).toBe(4);
  });

  it("records the reporting counts in the deletion's audit event", async () => {
    await seedReportedTeam();
    await deleteTeamRecord(db, { projectId: PROJECT_A, hackathonId: EDITION, operatorId: OPERATOR_ID });
    const [event] = await rows(`SELECT metadata FROM hq_audit_events WHERE kind='project.deleted'`);
    expect(event.metadata).toMatchObject({ reportingEntries: 1, reportingOutcomes: 1 });
  });

  it("leaves a person's reporting entries exactly where they are, because the account behind them is never deleted", async () => {
    await seedReportedTeam();
    const [card] = await rows(
      `INSERT INTO hq_people(hackathon_id,name,role_id,builder_user_id)
       SELECT $1,'Lead A',r.id,'lead-a' FROM hq_people_roles r LIMIT 1 RETURNING id::text AS id`,
      [EDITION],
    );
    const removal = await deletePersonRecord(db, { cardId: String(card.id), hackathonId: EDITION, operatorId: OPERATOR_ID });
    expect(removal).toMatchObject({ accountKept: true });
    expect(await rows(`SELECT author_kind, author_id FROM hq_reporting_entries`)).toEqual([{ author_kind: "member", author_id: "lead-a" }]);
    expect(await rows(`SELECT count(*)::int AS n FROM hq_reporting_entry_revisions`)).toEqual([{ n: 2 }]);
  });
});
