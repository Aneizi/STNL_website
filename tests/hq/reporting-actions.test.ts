// The phase 6 Server Actions against the real schema on PGlite: the member
// writes behind the team and Captain composers, the two contacts, and the
// admin schedule and settings controls.
//
// Nothing about authorization is mocked. Only the two session reads are
// stubbed (they are the boundary the actions are gated on), so every refusal
// below is the one the deployed action would return.
//
// The two refusals phase 6 owes a real answer are the point of this file:
// `period_changed` must name the week that is open now, and `conflict` must
// hand back the entry that is saved now, because the screens keep the
// person's unsaved text either way.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const mocks = vi.hoisted(() => ({
  builderDatabase: vi.fn(),
  requireMemberActor: vi.fn(),
  requireUser: vi.fn(),
  currentUser: vi.fn(),
  requireHackathon: vi.fn(),
}));
vi.mock("@/lib/hq/builder-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hq/builder-db")>()),
  builderDatabase: mocks.builderDatabase,
}));
vi.mock("@/lib/hq/actor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hq/actor")>()),
  requireMemberActor: mocks.requireMemberActor,
}));
vi.mock("@/lib/hq/auth", () => ({ requireUser: mocks.requireUser, currentUser: mocks.currentUser }));
vi.mock("@/lib/hq/hackathon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hq/hackathon")>()),
  requireHackathon: mocks.requireHackathon,
}));

import type { MemberActor } from "@/lib/hq/actor";
import {
  addReportingUpdate,
  editReportingUpdate,
  saveTeamContact,
} from "@/lib/hq/actions/reporting";
import {
  applyReportingSchedule,
  loadProjectReportingUpdates,
  previewReportingSchedule,
  readColosseumDeadline,
  saveReportingConfiguration,
} from "@/lib/hq/actions/reporting-admin";
import type { BuilderDatabase } from "@/lib/hq/builder-db";
import { grantCapability } from "@/lib/hq/capabilities";
import { assignCaptain } from "@/lib/hq/captains";
import { readTeamContact } from "@/lib/hq/reporting-contacts";
import {
  closePeriod,
  editUpdate,
  enableReporting,
  listReportingPeriods,
  readReportingConfig,
  reportingStatus,
} from "@/lib/hq/reporting";
import { createMigratedDatabase, pgliteBuilderDatabase } from "./helpers/db";

const OPERATOR_ID = "00000000-0000-4000-8000-0000000000b1";
const EDITION = 71;
const OTHER_EDITION = 72;
const PROJECT = "00000000-0000-4000-9100-000000000001";

let pg: PGlite;
let db: BuilderDatabase;

async function rows(text: string, values: unknown[] = []) {
  return (await pg.query(text, values)).rows as Record<string, unknown>[];
}

function member(id: string, capabilities: "captain"[] = []): MemberActor {
  return { kind: "member", id, name: id, email: `${id}@example.test`, capabilities: new Set(capabilities), telegram: null };
}

/** Sign in as this member for the next member action. */
function asMember(actor: MemberActor) {
  mocks.requireMemberActor.mockResolvedValue(actor);
}

/** Sign in as the operator for the next admin action. */
function asOperator() {
  mocks.requireUser.mockResolvedValue({ id: OPERATOR_ID, username: "op", displayName: "Operator", mustChangePassword: false });
}

async function seedAccount(id: string) {
  await rows(`INSERT INTO hq_auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,true) ON CONFLICT (id) DO NOTHING`, [id, id, `${id}@example.test`]);
  await rows(`INSERT INTO hq_builder_profiles(id,email,name) VALUES($1,$2,$3) ON CONFLICT (id) DO NOTHING`, [id, `${id}@example.test`, id]);
}

async function seedProject(id: string, hackathonId = EDITION, name = "Project") {
  await rows(
    `INSERT INTO hq_projects(id,hackathon_id,name,status_id,forecast_id,last_check_in)
     SELECT $1,$2,$3,s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f LIMIT 1`,
    [id, hackathonId, name],
  );
}

async function seedImportedProject(id: string, owner: string, options: { hackathonId?: number; members?: string[]; name?: string } = {}) {
  const hackathonId = options.hackathonId ?? EDITION;
  await seedProject(id, hackathonId, options.name ?? "Project");
  await seedAccount(owner);
  await rows(
    `INSERT INTO hq_project_onboarding(project_id,hackathon_id,external_id,project_url,slug,raw,owner_user_id,verification,lead_username)
     VALUES($1,$2,$3,$4,$5,'{}',$6,'verified',$6)`,
    [id, hackathonId, id.slice(-4), `https://colosseum.com/arena/projects/explore/${owner}`, owner, owner],
  );
  await rows(`INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at) VALUES($1,$2,$2,$2,now())`, [id, owner]);
  for (const teammate of options.members ?? []) {
    await seedAccount(teammate);
    await rows(`INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at) VALUES($1,$2,$2,$2,now())`, [id, teammate]);
  }
}

async function seedAssignedCaptain(userId: string, projectId: string) {
  await seedAccount(userId);
  await grantCapability(db, { actor: { kind: "operator", id: OPERATOR_ID }, byOperatorId: OPERATOR_ID, userId, capability: "captain", reason: "test" });
  const result = await assignCaptain(db, { actorOperatorId: OPERATOR_ID, projectId, hackathonId: EDITION, captainUserId: userId });
  if (result.outcome !== "assigned") throw new Error(`could not assign the test Captain: ${JSON.stringify(result)}`);
}

const openPeriod = async () => (await listReportingPeriods(db, EDITION))[0];

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
  mocks.builderDatabase.mockReturnValue(db);
  mocks.requireHackathon.mockResolvedValue({ id: EDITION, name: "Worlds Fair", slug: "worlds-fair", startDate: "2026-09-14", endDate: "2026-10-12" });
  asOperator();
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

describe("reading reporting updates in admin project details", () => {
  beforeEach(async () => {
    await seedImportedProject(PROJECT, "lead");
    await enableReporting(db, { projectId: PROJECT, hackathonId: EDITION });
    await seedAssignedCaptain("captain", PROJECT);
    asMember(member("captain", ["captain"]));
  });

  it("reads shared and private captain updates with pagination and keeps revision bodies out", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      const saved = await addReportingUpdate({
        projectId: PROJECT, hackathonId: EDITION, body: `Captain update ${i}`,
        visibility: i === 0 ? "sensitive" : "shared",
      });
      if (!saved.ok) throw new Error(saved.error);
      ids.push(saved.entry.id);
    }
    const first = await loadProjectReportingUpdates({ projectId: PROJECT });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    expect(first.page.entries).toHaveLength(10);
    expect(first.page.nextCursor).toBeTruthy();
    const second = await loadProjectReportingUpdates({ projectId: PROJECT, cursor: first.page.nextCursor! });
    if (!second.ok) throw new Error(second.error);
    expect(second.page.entries).toHaveLength(1);
    expect(second.page.nextCursor).toBeNull();
    const entries = [...first.page.entries, ...second.page.entries];
    expect(entries.map(entry => entry.id).sort()).toEqual(ids.sort());
    expect(entries.find(entry => entry.visibility === "sensitive")).toMatchObject({ body: "Captain update 0", authorName: "captain" });
    expect(entries.every(entry => !("revisions" in entry))).toBe(true);
  });

  it("does not read updates from another selected edition", async () => {
    await addReportingUpdate({ projectId: PROJECT, hackathonId: EDITION, body: "Private detail", visibility: "sensitive" });
    mocks.requireHackathon.mockResolvedValue({ id: OTHER_EDITION });
    expect(await loadProjectReportingUpdates({ projectId: PROJECT })).toEqual({ ok: true, page: { entries: [], nextCursor: null } });
  });

  it("requires an operator session even when a captain is signed in", async () => {
    mocks.requireUser.mockRejectedValueOnce(new Error("operator login required"));
    await expect(loadProjectReportingUpdates({ projectId: PROJECT })).rejects.toThrow("operator login required");
  });
});

describe("adding an update from a member surface", () => {
  beforeEach(async () => {
    await seedImportedProject(PROJECT, "lead", { members: ["mate"], name: "Our Team" });
    await enableReporting(db, { projectId: PROJECT, hackathonId: EDITION });
  });

  it("saves a team member's update and reports that it completed the week", async () => {
    asMember(member("lead"));
    const result = await addReportingUpdate({ projectId: PROJECT, hackathonId: EDITION, body: "  Shipped the swap flow.  " });
    expect(result).toMatchObject({ ok: true, completesPeriod: true });
    if (!result.ok) throw new Error("expected the save to succeed");
    // Trimmed on the server, authored by the signed-in account, not sensitive.
    expect(result.entry.body).toBe("Shipped the swap flow.");
    expect(result.entry.authorIsYou).toBe(true);
    expect(result.entry.visibility).toBe("shared");
  });

  it("names the week that is open now when the draft's week closed under it, and keeps nothing of the text", async () => {
    asMember(member("lead"));
    const [first, second] = await listReportingPeriods(db, EDITION);
    // The composer was opened against week one; by the time Save is pressed
    // the service resolves week two from the clock.
    vi.setSystemTime(new Date(second.startsAt));
    try {
      const result = await addReportingUpdate({
        projectId: PROJECT, hackathonId: EDITION, body: "Written last night.", expectedPeriodId: first.id,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.reason).toBe("period_changed");
      // The answer the screen needs: which week is open now.
      expect(result.reason === "period_changed" && result.currentPeriod?.id).toBe(second.id);
      expect(result.error).toMatch(/text is kept/i);
      // Nothing was written: the person decides which week the text belongs to.
      expect((await rows("SELECT count(*)::int AS n FROM hq_reporting_entries"))[0].n).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves into the new week once the person says so", async () => {
    asMember(member("lead"));
    const [, second] = await listReportingPeriods(db, EDITION);
    vi.setSystemTime(new Date(second.startsAt));
    try {
      const result = await addReportingUpdate({
        projectId: PROJECT, hackathonId: EDITION, body: "Written last night.", expectedPeriodId: second.id,
      });
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error("expected the save to succeed");
      expect(result.entry.periodId).toBe(second.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a team member's sensitive note with its own message, and never a generic one", async () => {
    asMember(member("lead"));
    const result = await addReportingUpdate({ projectId: PROJECT, hackathonId: EDITION, body: "Quiet word.", visibility: "sensitive" });
    expect(result).toMatchObject({ ok: false, reason: "visibility_not_allowed" });
    expect(result.ok === false && result.error).toMatch(/Captain/);
  });

  it("lets the assigned Captain save a sensitive note, which never completes the team's week", async () => {
    await seedAssignedCaptain("cap", PROJECT);
    asMember(member("cap", ["captain"]));
    const result = await addReportingUpdate({ projectId: PROJECT, hackathonId: EDITION, body: "Quiet word.", visibility: "sensitive" });
    expect(result).toMatchObject({ ok: true, completesPeriod: false });
    // The Captains' Den rule: a note is about the team, not from it, so the
    // week stays Not updated until a team member writes an update.
    const status = (await reportingStatus(db, { hackathonId: EDITION, projectIds: [PROJECT] }))[0];
    expect(status.current?.completed).toBe(false);
  });

  it("answers an unrelated account exactly as it answers a team that does not exist", async () => {
    await seedAccount("stranger");
    asMember(member("stranger"));
    const foreign = await addReportingUpdate({ projectId: PROJECT, hackathonId: EDITION, body: "Hello." });
    const missing = await addReportingUpdate({ projectId: "00000000-0000-4000-9100-0000000000ff", hackathonId: EDITION, body: "Hello." });
    if (foreign.ok || missing.ok) throw new Error("expected both to be refused");
    // Identical, reason and wording alike: the refusal must not tell a
    // stranger which project ids are real.
    expect(foreign.reason).toBe("not_authorized");
    expect({ reason: foreign.reason, error: foreign.error }).toEqual({ reason: missing.reason, error: missing.error });
  });

  it("refuses a blank update with its own message rather than writing an empty week", async () => {
    asMember(member("lead"));
    expect(await addReportingUpdate({ projectId: PROJECT, hackathonId: EDITION, body: "   " })).toMatchObject({ ok: false, reason: "empty_body" });
  });
});

describe("editing an update", () => {
  beforeEach(async () => {
    await seedImportedProject(PROJECT, "lead", { members: ["mate"] });
    await enableReporting(db, { projectId: PROJECT, hackathonId: EDITION });
  });

  it("hands back the version that is saved now when the edit lost a race", async () => {
    asMember(member("lead"));
    const created = await addReportingUpdate({ projectId: PROJECT, hackathonId: EDITION, body: "First draft." });
    if (!created.ok) throw new Error("expected the save to succeed");

    // Someone else saved over it in between, from the other interface: the
    // exact case the plan names for HQ and Telegram editing at once.
    const elsewhere = await editUpdate(
      { kind: "operator", id: OPERATOR_ID, displayName: "Operator" },
      { entryId: created.entry.id, body: "Saved by someone else.", expectedVersion: 1 },
      db,
    );
    expect(elsewhere).toMatchObject({ ok: true });

    const result = await editReportingUpdate({ entryId: created.entry.id, body: "My own rewrite.", expectedVersion: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a conflict");
    expect(result.reason).toBe("conflict");
    // The screen needs the saved text to show beside the unsaved one.
    expect(result.reason === "conflict" && result.current?.body).toBe("Saved by someone else.");
    expect(result.reason === "conflict" && result.current?.version).toBe(2);
    expect(result.error).toMatch(/kept below/i);
  });

  it("saves over it once the person has seen both and asked again", async () => {
    asMember(member("lead"));
    const created = await addReportingUpdate({ projectId: PROJECT, hackathonId: EDITION, body: "First draft." });
    if (!created.ok) throw new Error("expected the save to succeed");
    const result = await editReportingUpdate({ entryId: created.entry.id, body: "Second draft.", expectedVersion: 1 });
    expect(result).toMatchObject({ ok: true, changed: true });
    if (!result.ok) throw new Error("expected the edit to succeed");
    expect(result.entry.body).toBe("Second draft.");
    expect(result.entry.edited).toBe(true);
  });

  it("refuses an edit of somebody else's update", async () => {
    asMember(member("lead"));
    const created = await addReportingUpdate({ projectId: PROJECT, hackathonId: EDITION, body: "Mine." });
    if (!created.ok) throw new Error("expected the save to succeed");
    asMember(member("mate"));
    expect(await editReportingUpdate({ entryId: created.entry.id, body: "Not mine.", expectedVersion: 1 })).toMatchObject({
      ok: false, reason: "not_authorized",
    });
  });

  it("asks a Captain to confirm the new audience before a sensitive note becomes shared", async () => {
    await seedAssignedCaptain("cap", PROJECT);
    asMember(member("cap", ["captain"]));
    const created = await addReportingUpdate({ projectId: PROJECT, hackathonId: EDITION, body: "Quiet word.", visibility: "sensitive" });
    if (!created.ok) throw new Error("expected the save to succeed");
    expect(await editReportingUpdate({ entryId: created.entry.id, visibility: "shared", expectedVersion: 1 })).toMatchObject({
      ok: false, reason: "audience_not_confirmed",
    });
    expect(await editReportingUpdate({ entryId: created.entry.id, visibility: "shared", expectedVersion: 1, confirmAudienceChange: true })).toMatchObject({
      ok: true,
    });
  });
});

describe("the two contacts", () => {
  beforeEach(async () => {
    await seedImportedProject(PROJECT, "lead", { members: ["mate"] });
    await enableReporting(db, { projectId: PROJECT, hackathonId: EDITION });
  });

  it("lets the team lead set the team's contact, and nobody else", async () => {
    asMember(member("lead"));
    expect(await saveTeamContact({ projectId: PROJECT, hackathonId: EDITION, contact: "  @ourteam  " })).toEqual({ ok: true, contact: "@ourteam" });
    expect(await readTeamContact(db, PROJECT)).toBe("@ourteam");

    asMember(member("mate"));
    expect(await saveTeamContact({ projectId: PROJECT, hackathonId: EDITION, contact: "@notme" })).toMatchObject({ ok: false });
    expect(await readTeamContact(db, PROJECT)).toBe("@ourteam");
  });

  it("clears the team contact back to nothing rather than storing an empty line", async () => {
    asMember(member("lead"));
    await saveTeamContact({ projectId: PROJECT, hackathonId: EDITION, contact: "@ourteam" });
    expect(await saveTeamContact({ projectId: PROJECT, hackathonId: EDITION, contact: "   " })).toEqual({ ok: true, contact: null });
    expect(await readTeamContact(db, PROJECT)).toBeNull();
  });
});

describe("a late update after a week has closed", () => {
  beforeEach(async () => {
    await seedImportedProject(PROJECT, "lead");
    await enableReporting(db, { projectId: PROJECT, hackathonId: EDITION });
  });

  it("allows a deliberate late update without changing the closed outcome", async () => {
    const period = await openPeriod();
    await closePeriod(db, { periodId: period.id, actor: { kind: "operator", id: OPERATOR_ID, displayName: "Operator" }, atMs: Date.parse(period.endsAt) });
    asMember(member("lead"));
    const saved = await addReportingUpdate({ projectId: PROJECT, hackathonId: EDITION, body: "Late context", periodId: period.id });
    expect(saved).toMatchObject({ ok: true, completesPeriod: false, entry: { late: true } });
    expect(await rows(`SELECT completed, corrected_completed FROM hq_reporting_outcomes WHERE period_id=$1 AND project_id=$2`, [period.id, PROJECT]))
      .toEqual([{ completed: false, corrected_completed: null }]);
  });
});

describe("the admin schedule screen", () => {
  beforeEach(async () => {
    await seedImportedProject(PROJECT, "lead");
    await enableReporting(db, { projectId: PROJECT, hackathonId: EDITION });
  });

  it("previews a live date change without writing anything, and names the weeks it must not move", async () => {
    asMember(member("lead"));
    await addReportingUpdate({ projectId: PROJECT, hackathonId: EDITION, body: "Week one." });
    const before = await listReportingPeriods(db, EDITION);

    // The admin moves the hackathon's start a day later.
    await rows("UPDATE hq_hackathons SET start_date='2026-09-15' WHERE id=$1", [EDITION]);
    const preview = await previewReportingSchedule();
    expect(preview).toMatchObject({ ok: true });
    if (!preview.ok) throw new Error("expected the preview to succeed");
    // Week one holds an update, so it is a conflict rather than a move, and
    // the preview says what the dates would have made it.
    expect(preview.schedule.plan.conflicts).toHaveLength(1);
    expect(preview.schedule.plan.conflicts[0]).toMatchObject({ sequence: 1, reason: "has_entries", storedStartDate: "2026-09-14" });
    expect(preview.schedule.plan.conflicts[0].generatedStartDate).toBe("2026-09-15");
    // Nothing was written by the preview.
    expect(await listReportingPeriods(db, EDITION)).toEqual(before);
  });

  it("applies the change and still leaves the reported week exactly as it was", async () => {
    asMember(member("lead"));
    await addReportingUpdate({ projectId: PROJECT, hackathonId: EDITION, body: "Week one." });
    await rows("UPDATE hq_hackathons SET start_date='2026-09-15' WHERE id=$1", [EDITION]);
    const applied = await applyReportingSchedule();
    expect(applied).toMatchObject({ ok: true });
    if (!applied.ok) throw new Error("expected the apply to succeed");
    expect(applied.schedule.plan.conflicts).toHaveLength(1);
    const first = (await listReportingPeriods(db, EDITION))[0];
    expect(first.startDate).toBe("2026-09-14");
  });

  it("saves the reporting settings without touching the stored weeks", async () => {
    const before = await listReportingPeriods(db, EDITION);
    expect(await saveReportingConfiguration({
      finalPeriodStartDate: "2026-10-01",
      officialSubmissionDeadline: "2026-10-10T17:00",
      nudgeWeekday: 4,
      nudgeTime: "09:30",
    })).toEqual({ ok: true });
    const config = (await rows("SELECT final_period_start_date::text AS d, nudge_weekday, nudge_time::text AS t, official_submission_deadline FROM hq_reporting_config WHERE hackathon_id=$1", [EDITION]))[0];
    expect(config).toMatchObject({ d: "2026-10-01", nudge_weekday: 4, t: "09:30:00" });
    expect(config.official_submission_deadline).not.toBeNull();
    // The weeks only change when the admin applies, having seen the preview.
    expect(await listReportingPeriods(db, EDITION)).toEqual(before);
  });

  it("refuses a submission deadline it cannot read, rather than storing something wrong", async () => {
    expect(await saveReportingConfiguration({
      finalPeriodStartDate: "", officialSubmissionDeadline: "not a date", nudgeWeekday: 3, nudgeTime: "12:00",
    })).toMatchObject({ ok: false });
  });

  it.each([
    { finalPeriodStartDate: "2026-02-30" },
    { finalPeriodStartDate: "2026-11-01" },
    { officialSubmissionDeadline: "2026-02-30T12:00" },
    { nudgeTime: "29:99" },
  ])("rejects invalid schedule settings without a database or date conversion error: %j", async (change) => {
    expect(await saveReportingConfiguration({
      finalPeriodStartDate: "2026-10-05", officialSubmissionDeadline: "", nudgeWeekday: 3, nudgeTime: "12:00", ...change,
    })).toMatchObject({ ok: false });
  });

  // Phase 10's settings, saved through the same form.
  it("records which submission materials this hackathon asks for, dropping a key that is not one", async () => {
    expect(await saveReportingConfiguration({
      finalPeriodStartDate: "2026-10-05", officialSubmissionDeadline: "", nudgeWeekday: 3, nudgeTime: "12:00",
      requiredMaterials: ["presentation", "made-up"], optionalMaterials: ["repo"],
    })).toEqual({ ok: true });
    const config = await readReportingConfig(db, EDITION);
    expect(config.requiredMaterials).toEqual(["presentation"]);
    expect(config.optionalMaterials).toEqual(["repo"]);
  });

  it("leaves the materials alone when the form does not send them", async () => {
    await saveReportingConfiguration({
      finalPeriodStartDate: "2026-10-05", officialSubmissionDeadline: "", nudgeWeekday: 3, nudgeTime: "12:00",
      requiredMaterials: ["pitchVideo"],
    });
    await saveReportingConfiguration({
      finalPeriodStartDate: "2026-10-05", officialSubmissionDeadline: "", nudgeWeekday: 3, nudgeTime: "12:00",
    });
    expect((await readReportingConfig(db, EDITION)).requiredMaterials).toEqual(["pitchVideo"]);
  });

  it("refuses an automatic submission check more often than the floor, and takes zero as off", async () => {
    expect(await saveReportingConfiguration({
      finalPeriodStartDate: "", officialSubmissionDeadline: "", nudgeWeekday: 3, nudgeTime: "12:00",
      submissionRefreshMinutes: 5,
    })).toMatchObject({ ok: false });
    expect(await saveReportingConfiguration({
      finalPeriodStartDate: "", officialSubmissionDeadline: "", nudgeWeekday: 3, nudgeTime: "12:00",
      submissionRefreshMinutes: 60,
    })).toEqual({ ok: true });
    expect((await readReportingConfig(db, EDITION)).submissionRefreshMinutes).toBe(60);
    await saveReportingConfiguration({
      finalPeriodStartDate: "", officialSubmissionDeadline: "", nudgeWeekday: 3, nudgeTime: "12:00",
      submissionRefreshMinutes: 0,
    });
    expect((await readReportingConfig(db, EDITION)).submissionRefreshMinutes).toBeNull();
  });

  it("says which of the two put the deadline there", async () => {
    await saveReportingConfiguration({
      finalPeriodStartDate: "", officialSubmissionDeadline: "2026-10-12T23:59", nudgeWeekday: 3, nudgeTime: "12:00",
    });
    expect((await readReportingConfig(db, EDITION)).officialDeadlineSource).toBe("admin");
    // Saving the same form again does not relabel a deadline nobody changed.
    await saveReportingConfiguration({
      finalPeriodStartDate: "", officialSubmissionDeadline: "2026-10-12T23:59", nudgeWeekday: 3, nudgeTime: "12:00",
    });
    expect((await readReportingConfig(db, EDITION)).officialDeadlineSource).toBe("admin");
  });

  it("will not ask Colosseum for a deadline before an admin has set the edition's Colosseum id", async () => {
    const result = await readColosseumDeadline();
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toMatch(/Colosseum edition id/);
    // Nothing was written, and nothing was claimed about a deadline.
    expect((await readReportingConfig(db, EDITION)).officialDeadlineCheckedAt).toBeNull();
  });
});
