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
  currentReportingPeriod,
  enableReporting,
  ensureReportingPeriods,
  listReportingPeriods,
  pauseReporting,
  previewReportingPeriods,
  readReportingSchedule,
  reportingEligibility,
} from "@/lib/hq/reporting";
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
    const enabled = await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION, actor: member("lead-a") });
    expect(enabled).toMatchObject({ ok: true, created: true });
    expect(await reportingEligibility(db, PROJECT_A)).toMatchObject({ projectId: PROJECT_A, hackathonId: EDITION, paused: false });
    // "Store period identities once reporting begins": the first team entering
    // reporting is what makes the edition's schedule exist.
    expect((await listReportingPeriods(db, EDITION)).length).toBe(4);
  });

  it("is idempotent and never moves an existing eligibility start", async () => {
    await seedImportedProject(PROJECT_A, "lead-a");
    await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION, actor: member("lead-a") });
    const first = await reportingEligibility(db, PROJECT_A);
    const again = await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION, actor: OPERATOR, operatorId: OPERATOR_ID });
    expect(again).toMatchObject({ ok: true, created: false });
    expect((await reportingEligibility(db, PROJECT_A))?.eligibleFrom).toBe(first?.eligibleFrom);
  });

  it("enables a project an admin created directly, which has no imported team at all", async () => {
    await seedProject(BARE_PROJECT, EDITION, "CRM only");
    expect(await enableReporting(db, { projectId: BARE_PROJECT, hackathonId: EDITION, actor: OPERATOR, operatorId: OPERATOR_ID }))
      .toMatchObject({ ok: true, created: true });
    expect(await reportingEligibility(db, BARE_PROJECT)).toMatchObject({ projectId: BARE_PROJECT });
  });

  it("refuses a project from another edition and one that does not exist", async () => {
    await seedImportedProject(PROJECT_B, "lead-b", { hackathonId: OTHER_EDITION });
    expect(await enableReporting(db, { projectId: PROJECT_B, hackathonId: EDITION, actor: OPERATOR, operatorId: OPERATOR_ID }))
      .toEqual({ ok: false, reason: "not_found" });
    expect(await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION, actor: OPERATOR, operatorId: OPERATOR_ID }))
      .toEqual({ ok: false, reason: "not_found" });
  });

  it("resumes a paused project rather than restarting its eligibility", async () => {
    await seedImportedProject(PROJECT_A, "lead-a");
    await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION, actor: member("lead-a") });
    const start = (await reportingEligibility(db, PROJECT_A))?.eligibleFrom;
    await pauseReporting(db, { projectId: PROJECT_A, hackathonId: EDITION, paused: true, operatorId: OPERATOR_ID, actor: OPERATOR });
    expect(await reportingEligibility(db, PROJECT_A)).toMatchObject({ paused: true });
    await pauseReporting(db, { projectId: PROJECT_A, hackathonId: EDITION, paused: false, operatorId: OPERATOR_ID, actor: OPERATOR });
    expect(await reportingEligibility(db, PROJECT_A)).toMatchObject({ paused: false, eligibleFrom: start });
  });

  it("records an audit event for an admin enabling or pausing a project, and none for the import's own", async () => {
    await seedImportedProject(PROJECT_A, "lead-a");
    await seedProject(BARE_PROJECT, EDITION, "CRM only");
    await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION, actor: member("lead-a") });
    await enableReporting(db, { projectId: BARE_PROJECT, hackathonId: EDITION, actor: OPERATOR, operatorId: OPERATOR_ID });
    await pauseReporting(db, { projectId: BARE_PROJECT, hackathonId: EDITION, paused: true, operatorId: OPERATOR_ID, actor: OPERATOR });
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
    await enableReporting(db, { projectId: BARE_PROJECT, hackathonId: EDITION, actor: OPERATOR, operatorId: OPERATOR_ID });
    await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION, actor: member("lead-a") });
    // Reporting is keyed on hq_projects, not on hq_project_onboarding, so
    // eligibility, periods and status exist for both alike; what the CRM-only
    // project lacks is roster and Colosseum detail, which reporting never
    // needed.
    expect(await reportingEligibility(db, BARE_PROJECT)).toMatchObject({ projectId: BARE_PROJECT, imported: false, projectName: "CRM only" });
    expect(await reportingEligibility(db, PROJECT_A)).toMatchObject({ projectId: PROJECT_A, imported: true, projectName: "Imported" });
  });
});
