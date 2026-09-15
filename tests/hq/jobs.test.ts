// Phase 8's job runner against the real schema on PGlite: which reminders are
// due from the stored periods and the campaign timezone, what one reminder
// actually contains, what happens when the world changes between the scan and
// the send, and period closure.
//
// Nothing is mocked except `server-only` and the Telegram transport. The
// reporting service, the authorization decisions, the Captain assignments and
// the outgoing queue are the real ones over real rows, so an assertion below
// is an assertion about what the job would do in production.
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
import { grantCapability, revokeCapability } from "@/lib/hq/capabilities";
import { assignCaptain, unassignCaptain } from "@/lib/hq/captains";
import {
  REMINDER_TYPE_WEEKLY,
  closeDuePeriods,
  dueReminders,
  listReminderDeliveries,
  prepareReminder,
  runDueWork,
} from "@/lib/hq/jobs";
import { createUpdate, ensureReportingPeriods, enableReporting, listReportingPeriods, pauseReporting, reportingStatus } from "@/lib/hq/reporting";
import type { OutgoingMessage, TelegramSendOutcome, TelegramSender } from "@/lib/hq/telegram-bot-api";
import { createMigratedDatabase, pgliteBuilderDatabase } from "./helpers/db";

const OPERATOR_ID = "00000000-0000-4000-8000-0000000000b1";
const EDITION = 71;
const OTHER_EDITION = 72;
const PROJECT_A = "00000000-0000-4000-9100-000000000001";
const PROJECT_B = "00000000-0000-4000-9100-000000000002";
const PROJECT_C = "00000000-0000-4000-9100-000000000003";
const CAPTAIN = "captain-one";
const SECOND_CAPTAIN = "captain-two";
const TEAM_MEMBER = "member-one";

/** Wednesday 16 September 2026, 12:00 Europe/Amsterdam, the first period's stored nudge instant. */
const NUDGE_1 = Date.parse("2026-09-16T10:00:00.000Z");
/** Sunday 20 September 2026, 24:00 local: the first period's exclusive end. */
const PERIOD_1_END = Date.parse("2026-09-20T22:00:00.000Z");

let pg: PGlite;
let db: BuilderDatabase;

async function rows(text: string, values: unknown[] = []) {
  return (await pg.query(text, values)).rows as Record<string, unknown>[];
}

const member = (id: string, capabilities: "captain"[] = []): Actor => ({
  kind: "member", id, name: id, email: `${id}@example.test`, capabilities: new Set(capabilities), telegram: null,
});

async function seedAccount(id: string) {
  await rows(`INSERT INTO hq_auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,true) ON CONFLICT (id) DO NOTHING`, [id, id, `${id}@example.test`]);
  await rows(`INSERT INTO hq_builder_profiles(id,email,name) VALUES($1,$2,$3) ON CONFLICT (id) DO NOTHING`, [id, `${id}@example.test`, id]);
}

async function seedProject(id: string, name: string, hackathonId = EDITION) {
  await rows(
    `INSERT INTO hq_projects(id,hackathon_id,name,status_id,forecast_id,last_check_in)
     SELECT $1,$2,$3,s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f LIMIT 1`,
    [id, hackathonId, name],
  );
}

/** A team member who can write the update that satisfies a week. */
async function seedTeamMember(projectId: string, userId: string) {
  await seedAccount(userId);
  await rows(
    `INSERT INTO hq_project_onboarding(project_id,hackathon_id,external_id,project_url,slug,raw,owner_user_id,verification,lead_username)
     VALUES($1,$2,$3,$4,$5,'{}',$6,'verified',$6) ON CONFLICT (project_id) DO NOTHING`,
    [projectId, EDITION, Math.floor(Math.random() * 1e9), `https://colosseum.com/arena/projects/explore/${userId}`, userId, userId],
  );
  await rows(
    `INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at) VALUES($1,$2,$2,$2,now())
     ON CONFLICT DO NOTHING`,
    [projectId, userId],
  );
}

/** An account with an active Captain grant, assigned to the project. */
async function seedAssignedCaptain(userId: string, projectId: string, hackathonId = EDITION) {
  await seedAccount(userId);
  await grantCapability(db, { actor: { kind: "operator", id: OPERATOR_ID }, byOperatorId: OPERATOR_ID, userId, capability: "captain", reason: "test" });
  const result = await assignCaptain(db, { actorOperatorId: OPERATOR_ID, projectId, hackathonId, captainUserId: userId });
  if (result.outcome !== "assigned") throw new Error(`could not assign the test Captain: ${JSON.stringify(result)}`);
}

/** Telegram connected and bot messages agreed to, with a bound private chat. */
async function seedBotReach(userId: string, telegramUserId: string, chatId = telegramUserId, messaging = true) {
  await rows(
    `INSERT INTO hq_auth_telegram_identity(user_id,provider_subject,telegram_user_id) VALUES($1,$2,$3::bigint)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, `telegram:${telegramUserId}`, telegramUserId],
  );
  await rows(
    `INSERT INTO hq_telegram_bot_consent(user_id,telegram_user_id,messaging_enabled,chat_id,consented_at)
     VALUES($1,$2::bigint,$3,$4::bigint,now())
     ON CONFLICT (user_id) DO UPDATE SET messaging_enabled = EXCLUDED.messaging_enabled, chat_id = EXCLUDED.chat_id`,
    [userId, telegramUserId, messaging, chatId],
  );
}

/** Puts a project into reporting from the campaign's first instant, so it is accountable for period 1. */
async function enrol(projectId: string, hackathonId = EDITION) {
  const result = await enableReporting(db, { projectId, hackathonId, operatorId: OPERATOR_ID });
  if (!result.ok) throw new Error(`could not enrol ${projectId}`);
  await rows("UPDATE hq_reporting_eligibility SET eligible_from = $2::timestamptz WHERE project_id = $1::uuid", [projectId, "2026-09-13T22:00:00.000Z"]);
}

/** A Telegram transport that records what it was asked to send and answers however the test says. */
function fakeSender(outcome: TelegramSendOutcome = { ok: true, messageId: 4242 }) {
  const sent: OutgoingMessage[] = [];
  const sender: TelegramSender = {
    async sendMessage(message) { sent.push(message); return outcome; },
    async answerCallbackQuery() {},
  };
  return { sender, sent };
}

const outgoing = () => rows("SELECT id::text AS id, chat_id::text AS chat_id, kind, body, dedupe_key, state, skip_reason, provider_message_id FROM hq_telegram_outgoing ORDER BY created_at, id");
const deliveries = () => rows("SELECT captain_user_id, hackathon_id, period_id::text AS period_id, reminder_type, state, reason, project_count, provider_message_id::text AS provider_message_id FROM hq_reminder_deliveries ORDER BY captain_user_id");

async function periodOne() {
  const periods = await listReportingPeriods(db, EDITION);
  return periods[0];
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
  await pg.exec(`
    DELETE FROM hq_reminder_deliveries;
    DELETE FROM hq_telegram_outgoing; DELETE FROM hq_telegram_actions; DELETE FROM hq_telegram_drafts; DELETE FROM hq_telegram_updates;
    DELETE FROM hq_telegram_bot_consent; DELETE FROM hq_auth_telegram_identity;
    DELETE FROM hq_reporting_entry_revisions; DELETE FROM hq_reporting_entries; DELETE FROM hq_reporting_outcomes;
    DELETE FROM hq_reporting_pause_intervals; DELETE FROM hq_reporting_eligibility; DELETE FROM hq_reporting_periods;
    DELETE FROM hq_reporting_config;
    DELETE FROM hq_captain_assignments; DELETE FROM hq_account_capabilities; DELETE FROM hq_audit_events;
    DELETE FROM hq_project_members; DELETE FROM hq_project_onboarding; DELETE FROM hq_projects;
    DELETE FROM hq_builder_enrollments; DELETE FROM hq_people; DELETE FROM hq_crm_persons;
    DELETE FROM hq_builder_profiles; DELETE FROM hq_auth_user;
    DELETE FROM hq_settings; DELETE FROM hq_hackathons;
  `);
  await rows(`INSERT INTO hq_hackathons(id,slug,name,start_date,end_date) VALUES($1,'worlds-fair','Crypto Worlds Fair','2026-09-14','2026-10-12')`, [EDITION]);
  await rows(`INSERT INTO hq_hackathons(id,slug,name,start_date,end_date) VALUES($1,'frontier','Frontier','2026-05-04','2026-05-31')`, [OTHER_EDITION]);
  await rows(`INSERT INTO hq_reporting_config(hackathon_id,final_period_start_date) VALUES($1,'2026-10-05')`, [EDITION]);
  await ensureReportingPeriods(db, EDITION);
  await seedProject(PROJECT_A, "Alpha");
  await seedProject(PROJECT_B, "Beta");
  await enrol(PROJECT_A);
  await enrol(PROJECT_B);
  await seedAssignedCaptain(CAPTAIN, PROJECT_A);
  await seedAssignedCaptain(CAPTAIN, PROJECT_B);
  await seedBotReach(CAPTAIN, "5551");
});

/* ---------------------------------------------------------------------------
 * Timing
 * ------------------------------------------------------------------------ */

describe("dueReminders", () => {
  it("is not due one millisecond before the stored nudge instant", async () => {
    expect(await dueReminders(db, { atMs: NUDGE_1 - 1 })).toEqual([]);
  });

  it("is due exactly at the stored nudge instant, for the open period", async () => {
    const due = await dueReminders(db, { atMs: NUDGE_1 });
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ captainUserId: CAPTAIN, hackathonId: EDITION, reminderType: REMINDER_TYPE_WEEKLY });
    expect(due[0].period.sequence).toBe(1);
  });

  it("still catches up later in the same week, so a missed job is not a lost week", async () => {
    const due = await dueReminders(db, { atMs: PERIOD_1_END - 60_000 });
    expect(due).toHaveLength(1);
    expect(due[0].period.sequence).toBe(1);
  });

  it("stops at the period's exclusive end rather than spilling into the next week", async () => {
    // The instant period 1 ends is period 2's first instant, and period 2's
    // own nudge has not arrived yet.
    expect(await dueReminders(db, { atMs: PERIOD_1_END })).toEqual([]);
  });

  it("sends nothing outside the campaign's own dates", async () => {
    expect(await dueReminders(db, { atMs: Date.parse("2026-09-01T10:00:00.000Z") })).toEqual([]);
    expect(await dueReminders(db, { atMs: Date.parse("2026-11-01T10:00:00.000Z") })).toEqual([]);
  });

  it("sends nothing for a period that has already been closed", async () => {
    const period = await periodOne();
    await rows("UPDATE hq_reporting_periods SET closed_at = now() WHERE id = $1::uuid", [period.id]);
    expect(await dueReminders(db, { atMs: NUDGE_1 })).toEqual([]);
  });

  it("sends nothing for an archived edition, and needs no archiving to stop outside the dates", async () => {
    await rows("UPDATE hq_hackathons SET archived_at = now() WHERE id = $1", [EDITION]);
    expect(await dueReminders(db, { atMs: NUDGE_1 })).toEqual([]);
  });

  it("drops a paused project, and the Captain with it when nothing else is left", async () => {
    await pauseReporting(db, { projectId: PROJECT_A, hackathonId: EDITION, paused: true, operatorId: OPERATOR_ID });
    await pauseReporting(db, { projectId: PROJECT_B, hackathonId: EDITION, paused: true, operatorId: OPERATOR_ID });
    expect(await dueReminders(db, { atMs: NUDGE_1 })).toEqual([]);
  });

  it("fabricates nothing for a team that entered reporting after the week ended", async () => {
    await seedProject(PROJECT_C, "Gamma");
    await enableReporting(db, { projectId: PROJECT_C, hackathonId: EDITION, operatorId: OPERATOR_ID });
    await rows("UPDATE hq_reporting_eligibility SET eligible_from = $2::timestamptz WHERE project_id = $1::uuid", [PROJECT_C, "2026-10-01T00:00:00.000Z"]);
    await seedAssignedCaptain(SECOND_CAPTAIN, PROJECT_C);
    await seedBotReach(SECOND_CAPTAIN, "5552");
    expect((await dueReminders(db, { atMs: NUDGE_1 })).map((row) => row.captainUserId)).toEqual([CAPTAIN]);
  });

  it("stops offering a reminder once one has been recorded for that Captain, edition and week", async () => {
    const period = await periodOne();
    await prepareReminder(db, { captainUserId: CAPTAIN, hackathonId: EDITION, periodId: period.id, atMs: NUDGE_1 });
    expect(await dueReminders(db, { atMs: NUDGE_1 + 60_000 })).toEqual([]);
  });

  it("keeps a Captain's two editions apart rather than mixing their deadlines", async () => {
    await rows(`INSERT INTO hq_reporting_config(hackathon_id,final_period_start_date) VALUES($1,NULL) ON CONFLICT DO NOTHING`, [OTHER_EDITION]);
    await rows("UPDATE hq_hackathons SET start_date='2026-09-14', end_date='2026-10-12' WHERE id=$1", [OTHER_EDITION]);
    await ensureReportingPeriods(db, OTHER_EDITION);
    await seedProject(PROJECT_C, "Gamma", OTHER_EDITION);
    await enrol(PROJECT_C, OTHER_EDITION);
    await seedAssignedCaptain(CAPTAIN, PROJECT_C, OTHER_EDITION);
    const due = await dueReminders(db, { atMs: NUDGE_1 });
    expect(due).toHaveLength(2);
    expect(new Set(due.map((row) => row.hackathonId))).toEqual(new Set([EDITION, OTHER_EDITION]));
  });

  it("puts the nudge on the configured local clock either side of an autumn clock change", async () => {
    // Reusable scheduling: this edition ends before the transition, but the
    // generator and the job must agree on what 12:00 local means when the
    // offset moves. 2026's EU change is Sunday 25 October.
    await rows("DELETE FROM hq_reporting_periods WHERE hackathon_id = $1", [EDITION]);
    await rows("UPDATE hq_hackathons SET start_date='2026-10-19', end_date='2026-11-01' WHERE id=$1", [EDITION]);
    await rows("UPDATE hq_reporting_config SET final_period_start_date = NULL WHERE hackathon_id=$1", [EDITION]);
    await ensureReportingPeriods(db, EDITION);
    const periods = await listReportingPeriods(db, EDITION);
    // 12:00 CEST is 10:00 UTC; after the change 12:00 CET is 11:00 UTC.
    expect(periods.map((period) => period.nudgeAt)).toEqual(["2026-10-21T10:00:00.000Z", "2026-10-28T11:00:00.000Z"]);
    expect(await dueReminders(db, { atMs: Date.parse("2026-10-28T10:59:59.999Z") })).toEqual([]);
    expect(await dueReminders(db, { atMs: Date.parse("2026-10-28T11:00:00.000Z") })).toHaveLength(1);
  });
});

/* ---------------------------------------------------------------------------
 * What one reminder contains
 * ------------------------------------------------------------------------ */

describe("prepareReminder", () => {
  it("queues one message naming only the Captain's outstanding teams", async () => {
    const period = await periodOne();
    const result = await prepareReminder(db, { captainUserId: CAPTAIN, hackathonId: EDITION, periodId: period.id, atMs: NUDGE_1, hqOrigin: "https://hq.example.test" });
    expect(result).toMatchObject({ ok: true, state: "queued", projects: 2 });

    const queued = await outgoing();
    expect(queued).toHaveLength(1);
    expect(queued[0].kind).toBe("reminder");
    expect(queued[0].chat_id).toBe("5551");
    expect(String(queued[0].body)).toContain("Alpha");
    expect(String(queued[0].body)).toContain("Beta");
    expect(String(queued[0].dedupe_key)).toContain(period.id);
    expect(await deliveries()).toEqual([
      { captain_user_id: CAPTAIN, hackathon_id: EDITION, period_id: period.id, reminder_type: REMINDER_TYPE_WEEKLY, state: "queued", reason: null, project_count: 2, provider_message_id: null },
    ]);
  });

  it("leaves out a team that has already updated this week", async () => {
    await seedTeamMember(PROJECT_A, TEAM_MEMBER);
    const saved = await createUpdate(member(TEAM_MEMBER), { projectId: PROJECT_A, hackathonId: EDITION, body: "Shipped the importer.", atMs: NUDGE_1 - 3_600_000 }, db);
    expect(saved.ok).toBe(true);
    const period = await periodOne();
    const result = await prepareReminder(db, { captainUserId: CAPTAIN, hackathonId: EDITION, periodId: period.id, atMs: NUDGE_1 });
    expect(result).toMatchObject({ ok: true, state: "queued", projects: 1 });
    const queued = await outgoing();
    expect(String(queued[0].body)).toContain("Beta");
    expect(String(queued[0].body)).not.toContain("Alpha");
  });

  it("cancels the message when every assigned team has updated, and records why", async () => {
    await seedTeamMember(PROJECT_A, TEAM_MEMBER);
    await seedTeamMember(PROJECT_B, "member-two");
    await createUpdate(member(TEAM_MEMBER), { projectId: PROJECT_A, hackathonId: EDITION, body: "Done.", atMs: NUDGE_1 - 1000 }, db);
    await createUpdate(member("member-two"), { projectId: PROJECT_B, hackathonId: EDITION, body: "Done too.", atMs: NUDGE_1 - 1000 }, db);
    const period = await periodOne();
    const result = await prepareReminder(db, { captainUserId: CAPTAIN, hackathonId: EDITION, periodId: period.id, atMs: NUDGE_1 });
    expect(result).toMatchObject({ ok: true, state: "skipped", reason: "nothing_outstanding" });
    expect(await outgoing()).toEqual([]);
    expect((await deliveries())[0]).toMatchObject({ state: "skipped", reason: "nothing_outstanding", project_count: 0 });
  });

  it("never carries an update body or a sensitive flag into the notification", async () => {
    await seedTeamMember(PROJECT_A, TEAM_MEMBER);
    const note = await createUpdate(member(CAPTAIN, ["captain"]), {
      projectId: PROJECT_B, hackathonId: EDITION, body: "A private worry about the team.", visibility: "sensitive", atMs: NUDGE_1 - 1000,
    }, db);
    expect(note.ok).toBe(true);
    const period = await periodOne();
    await prepareReminder(db, { captainUserId: CAPTAIN, hackathonId: EDITION, periodId: period.id, atMs: NUDGE_1 });
    const queued = await outgoing();
    expect(String(queued[0].body)).not.toContain("private worry");
    expect(String(queued[0].body).toLowerCase()).not.toContain("sensitive");
  });

  it("records a skip when the Captain never connected Telegram", async () => {
    await rows("DELETE FROM hq_telegram_bot_consent WHERE user_id = $1", [CAPTAIN]);
    await rows("DELETE FROM hq_auth_telegram_identity WHERE user_id = $1", [CAPTAIN]);
    const period = await periodOne();
    const result = await prepareReminder(db, { captainUserId: CAPTAIN, hackathonId: EDITION, periodId: period.id, atMs: NUDGE_1 });
    expect(result).toMatchObject({ ok: true, state: "skipped", reason: "telegram_disconnected" });
    expect(await outgoing()).toEqual([]);
  });

  it("records a skip when the Captain turned bot messages off", async () => {
    await rows("UPDATE hq_telegram_bot_consent SET messaging_enabled = false WHERE user_id = $1", [CAPTAIN]);
    const period = await periodOne();
    const result = await prepareReminder(db, { captainUserId: CAPTAIN, hackathonId: EDITION, periodId: period.id, atMs: NUDGE_1 });
    expect(result).toMatchObject({ ok: true, state: "skipped", reason: "messaging_disabled" });
    expect(await outgoing()).toEqual([]);
  });

  it("records a skip when Telegram is connected but the chat has never been opened", async () => {
    await rows("UPDATE hq_telegram_bot_consent SET chat_id = NULL WHERE user_id = $1", [CAPTAIN]);
    const period = await periodOne();
    const result = await prepareReminder(db, { captainUserId: CAPTAIN, hackathonId: EDITION, periodId: period.id, atMs: NUDGE_1 });
    expect(result).toMatchObject({ ok: true, state: "skipped", reason: "no_chat" });
  });

  it("does not name a project the Captain lost between the scan and the send", async () => {
    const period = await periodOne();
    await unassignCaptain(db, { actorOperatorId: OPERATOR_ID, projectId: PROJECT_A, hackathonId: EDITION });
    const result = await prepareReminder(db, { captainUserId: CAPTAIN, hackathonId: EDITION, periodId: period.id, atMs: NUDGE_1 });
    expect(result).toMatchObject({ ok: true, state: "queued", projects: 1 });
    expect(String((await outgoing())[0].body)).not.toContain("Alpha");
  });

  it("records a skip when the Captain capability was revoked before the send", async () => {
    const period = await periodOne();
    await revokeCapability(db, { actor: { kind: "operator", id: OPERATOR_ID }, byOperatorId: OPERATOR_ID, userId: CAPTAIN, capability: "captain", reason: "test" });
    const result = await prepareReminder(db, { captainUserId: CAPTAIN, hackathonId: EDITION, periodId: period.id, atMs: NUDGE_1 });
    expect(result).toMatchObject({ ok: true, state: "skipped", reason: "capability_revoked" });
    expect(await outgoing()).toEqual([]);
  });

  it("writes one delivery and one message however many times it is asked", async () => {
    const period = await periodOne();
    const first = await prepareReminder(db, { captainUserId: CAPTAIN, hackathonId: EDITION, periodId: period.id, atMs: NUDGE_1 });
    const second = await prepareReminder(db, { captainUserId: CAPTAIN, hackathonId: EDITION, periodId: period.id, atMs: NUDGE_1 + 5_000 });
    expect(first).toMatchObject({ ok: true, state: "queued" });
    expect(second).toEqual({ ok: false, reason: "already_recorded" });
    expect(await outgoing()).toHaveLength(1);
    expect(await deliveries()).toHaveLength(1);
  });

  it("does not resend after an admin edits the dates, because the key is the week's identity", async () => {
    // The plan's phase 5 rule, met here: "Date edits must not silently
    // relabel historical entries or resend old reminders." A period keeps its
    // id when its dates move, and the reminder key is that id.
    const period = await periodOne();
    await prepareReminder(db, { captainUserId: CAPTAIN, hackathonId: EDITION, periodId: period.id, atMs: NUDGE_1 });
    await rows("UPDATE hq_hackathons SET start_date='2026-09-15' WHERE id=$1", [EDITION]);
    await ensureReportingPeriods(db, EDITION);
    const moved = await periodOne();
    // Same row, different dates: the change really was applied, so the check
    // below is about the key and not about a no-op.
    expect(moved.id).toBe(period.id);
    expect([period.startDate, moved.startDate]).toEqual(["2026-09-14", "2026-09-15"]);
    expect(await dueReminders(db, { atMs: NUDGE_1 + 3_600_000 })).toEqual([]);
    expect(await outgoing()).toHaveLength(1);
  });

  it("refuses a week that is not open at the instant asked about", async () => {
    const period = await periodOne();
    expect(await prepareReminder(db, { captainUserId: CAPTAIN, hackathonId: EDITION, periodId: period.id, atMs: PERIOD_1_END })).toEqual({ ok: false, reason: "not_due" });
    expect(await deliveries()).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------
 * Closure
 * ------------------------------------------------------------------------ */

describe("closeDuePeriods", () => {
  it("closes every week whose end has passed, once, and records the missed ones", async () => {
    const first = await closeDuePeriods(db, { atMs: Date.parse("2026-09-28T00:00:00.000Z") });
    expect(first.closed.map((row) => row.sequence)).toEqual([1, 2]);
    expect(first.closed[0]).toMatchObject({ missed: 2, completed: 0 });
    const outcomes = await rows("SELECT project_id::text AS project_id, completed, exempt FROM hq_reporting_outcomes ORDER BY project_id");
    expect(outcomes).toHaveLength(4);

    const second = await closeDuePeriods(db, { atMs: Date.parse("2026-09-28T00:00:00.000Z") });
    expect(second.closed).toEqual([]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_reporting_outcomes")).toEqual([{ n: 4 }]);
  });

  it("leaves an open week alone", async () => {
    expect((await closeDuePeriods(db, { atMs: NUDGE_1 })).closed).toEqual([]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_reporting_outcomes")).toEqual([{ n: 0 }]);
  });

  it("records the Captain responsible at close, and a later reassignment does not rewrite it", async () => {
    await closeDuePeriods(db, { atMs: PERIOD_1_END + 1000 });
    await unassignCaptain(db, { actorOperatorId: OPERATOR_ID, projectId: PROJECT_A, hackathonId: EDITION });
    const outcome = await rows("SELECT captain_user_id FROM hq_reporting_outcomes WHERE project_id = $1::uuid", [PROJECT_A]);
    expect(outcome).toEqual([{ captain_user_id: CAPTAIN }]);
  });

  it("keeps a closed missed week missed when a late entry arrives afterwards", async () => {
    await seedTeamMember(PROJECT_A, TEAM_MEMBER);
    await closeDuePeriods(db, { atMs: PERIOD_1_END + 1000 });
    const period = await periodOne();
    const late = await createUpdate(member(TEAM_MEMBER), {
      projectId: PROJECT_A, hackathonId: EDITION, body: "Sorry, late.", periodId: period.id, atMs: PERIOD_1_END + 7_200_000,
    }, db);
    expect(late.ok).toBe(true);
    const status = await reportingStatus(db, { hackathonId: EDITION, projectIds: [PROJECT_A], atMs: PERIOD_1_END + 7_200_000, includeHistory: true });
    expect(status[0].history[0]).toMatchObject({ periodSequence: 1, completed: false, closed: true });
  });

  it("writes one period_closed audit event per week, from the job rather than a person", async () => {
    await closeDuePeriods(db, { atMs: PERIOD_1_END + 1000 });
    const events = await rows("SELECT kind, actor_kind, actor_id FROM hq_audit_events WHERE kind = 'reporting.period_closed'");
    expect(events).toEqual([{ kind: "reporting.period_closed", actor_kind: "system", actor_id: null }]);
  });
});

/* ---------------------------------------------------------------------------
 * The whole pass
 * ------------------------------------------------------------------------ */

describe("runDueWork", () => {
  it("sends one Wednesday message to the Captain and records the delivery", async () => {
    const { sender, sent } = fakeSender();
    const summary = await runDueWork({ db, sender, now: NUDGE_1, hqOrigin: "https://hq.example.test" });
    expect(summary.reminders).toMatchObject({ due: 1, queued: 1, skipped: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe("5551");
    expect(sent[0].text).toContain("Alpha");
    expect((await deliveries())[0]).toMatchObject({ state: "sent", provider_message_id: "4242" });
  });

  it("does not send a second message when the pass runs again in the same week", async () => {
    const first = fakeSender();
    await runDueWork({ db, sender: first.sender, now: NUDGE_1 });
    const second = fakeSender();
    const summary = await runDueWork({ db, sender: second.sender, now: NUDGE_1 + 900_000 });
    expect(second.sent).toEqual([]);
    expect(summary.reminders.due).toBe(0);
    expect(await deliveries()).toHaveLength(1);
  });

  it("delivers once when two passes run over each other", async () => {
    const a = fakeSender();
    const b = fakeSender();
    await Promise.all([
      runDueWork({ db, sender: a.sender, now: NUDGE_1 }),
      runDueWork({ db, sender: b.sender, now: NUDGE_1 }),
    ]);
    expect(a.sent.length + b.sent.length).toBe(1);
    expect(await outgoing()).toHaveLength(1);
    expect(await deliveries()).toHaveLength(1);
  });

  it("does not deliver a queued reminder after the Captain turns bot messages off", async () => {
    const period = await periodOne();
    await prepareReminder(db, { captainUserId: CAPTAIN, hackathonId: EDITION, periodId: period.id, atMs: NUDGE_1 });
    await rows("UPDATE hq_telegram_bot_consent SET messaging_enabled = false WHERE user_id = $1", [CAPTAIN]);
    const { sender, sent } = fakeSender();
    await runDueWork({ db, sender, now: NUDGE_1 + 1000 });
    expect(sent).toEqual([]);
    expect((await deliveries())[0]).toMatchObject({ state: "skipped", reason: "messaging_disabled" });
  });

  it("drops a reminder whose week ended before it could be delivered", async () => {
    const period = await periodOne();
    await prepareReminder(db, { captainUserId: CAPTAIN, hackathonId: EDITION, periodId: period.id, atMs: NUDGE_1 });
    const { sender, sent } = fakeSender();
    await runDueWork({ db, sender, now: PERIOD_1_END + 1000 });
    expect(sent).toEqual([]);
    expect((await deliveries())[0]).toMatchObject({ state: "skipped", reason: "period_over" });
  });

  it("records a rate limit as a retry rather than a delivery, and leaves it retryable", async () => {
    const { sender, sent } = fakeSender({ ok: false, retryable: true, code: "telegram_429", detail: "Too Many Requests", retryAfterSeconds: 30 });
    await runDueWork({ db, sender, now: NUDGE_1 });
    expect(sent).toHaveLength(1);
    expect((await deliveries())[0]).toMatchObject({ state: "queued" });
    expect((await outgoing())[0]).toMatchObject({ state: "queued" });
  });

  it("records a blocked bot permanently, without a new weekly project status", async () => {
    const { sender } = fakeSender({ ok: false, retryable: false, code: "telegram_403", detail: "Forbidden: bot was blocked by the user" });
    await runDueWork({ db, sender, now: NUDGE_1 });
    expect((await deliveries())[0]).toMatchObject({ state: "skipped", reason: "telegram_403" });
    const status = await reportingStatus(db, { hackathonId: EDITION, atMs: NUDGE_1, includeHistory: true });
    // The reminder's fate changed no week's answer: both teams are still
    // simply Not updated, which is the only weekly vocabulary there is.
    expect(status.map((row) => row.current?.completed)).toEqual([false, false]);
  });

  it("closes the weeks that ended and sends nothing for them", async () => {
    const { sender, sent } = fakeSender();
    const summary = await runDueWork({ db, sender, now: Date.parse("2026-09-28T12:00:00.000Z") });
    expect(summary.closures.closed).toBe(2);
    expect(summary.reminders.due).toBe(0);
    expect(sent).toEqual([]);
  });

  it("runs without a Telegram transport, leaving the message queued for the next pass", async () => {
    const summary = await runDueWork({ db, sender: null, now: NUDGE_1 });
    expect(summary.reminders.queued).toBe(1);
    expect(summary.delivery).toBeNull();
    expect((await outgoing())[0]).toMatchObject({ state: "queued" });
  });

  it("sweeps expired bot state on the same pass", async () => {
    await rows(
      `INSERT INTO hq_telegram_drafts(user_id,chat_id,project_id,hackathon_id,step,expires_at) VALUES($1,$2::bigint,$3::uuid,$4,'awaiting_text',$5::timestamptz)`,
      [CAPTAIN, "5551", PROJECT_A, EDITION, new Date(NUDGE_1 - 60_000).toISOString()],
    );
    const { sender } = fakeSender();
    const summary = await runDueWork({ db, sender, now: NUDGE_1 });
    expect(summary.purged.drafts).toBe(1);
    expect(await rows("SELECT count(*)::int AS n FROM hq_telegram_drafts")).toEqual([{ n: 0 }]);
  });
});

describe("listReminderDeliveries", () => {
  it("shows an admin what happened to each reminder, newest first", async () => {
    const { sender } = fakeSender();
    await runDueWork({ db, sender, now: NUDGE_1 });
    const listed = await listReminderDeliveries(db, { hackathonId: EDITION });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      captainUserId: CAPTAIN, captainName: CAPTAIN, periodSequence: 1, state: "sent", projectCount: 2, reason: null,
    });
  });

  it("carries no update text of any kind", async () => {
    await seedTeamMember(PROJECT_A, TEAM_MEMBER);
    await createUpdate(member(CAPTAIN, ["captain"]), { projectId: PROJECT_B, hackathonId: EDITION, body: "A private worry.", visibility: "sensitive", atMs: NUDGE_1 - 1000 }, db);
    const { sender } = fakeSender();
    await runDueWork({ db, sender, now: NUDGE_1 });
    expect(JSON.stringify(await listReminderDeliveries(db, { hackathonId: EDITION }))).not.toContain("private worry");
  });
});
