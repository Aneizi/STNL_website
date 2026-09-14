import "server-only";
import type { Actor } from "./actor";
import { recordAuditEvent, type AuditActor } from "./audit";
import { atomically, builderDatabase, type BuilderDatabase, type BuilderQuery } from "./builder-db";
import {
  generateReportingPeriods,
  periodForInstant,
  type GeneratedPeriod,
  type ReportingPeriodMode,
  type ReportingSchedule,
} from "./reporting-periods";

/**
 * The reporting service (contracts.md's "Reporting service" row): the one
 * place periods, eligibility, entries, revisions, completion and outcomes are
 * written, shared by the web actions today and the Telegram bot in phase 7.
 * Web actions and bot handlers stay thin callers; every rule below is
 * enforced here, on the server, over facts read in the same transaction.
 *
 * Where each thing lives:
 *
 * - The schedule arithmetic is pure and lives in ./reporting-periods, so the
 *   plan's period table can be asserted literally without a database.
 * - Every project decision goes through `authorizeProjectAction` in ./authz.
 *   There is no second per-action permission rule here, and an entry's
 *   audience is `entryAudience`/`canEditEntry` over `loadEntry` — the phase 1
 *   decisions, unchanged.
 * - The tables are documented where they are created, in
 *   scripts/hq/builder-schema.sql. Read those comment blocks before changing
 *   anything here.
 *
 * Reporting is keyed on `hq_projects`, never on `hq_project_onboarding`. A
 * project an admin created directly in the CRM, with no imported team behind
 * it, therefore has exactly the same reporting record as an imported one once
 * an admin enables it: the same eligibility row, the same periods, the same
 * status, and a name to show. That is the deliberate answer to the reduced
 * card `/hq/captain` falls back to for such a project (contracts.md's "A
 * known UX gap phase 5 will meet again"): what that project lacks is roster
 * and Colosseum detail, which reporting never needed, so a reporting surface
 * has nothing reduced about it. `imported` is carried on the eligibility and
 * status shapes so a caller that also wants to show team detail knows in
 * advance whether there is any.
 */

/** The campaign timezone when an edition has no `timezone` setting of its own; matches SETTINGS_FALLBACK in ./queries. */
const DEFAULT_TIMEZONE = "Europe/Amsterdam";
/** ISO weekday 3, Wednesday: the plan's mid-period nudge day, and the column default. */
const DEFAULT_NUDGE_WEEKDAY = 3;
const DEFAULT_NUDGE_TIME = "12:00";

const toIso = (value: unknown) => (value instanceof Date ? value : new Date(String(value))).toISOString();
/** A `date` column as an ISO day. The pg driver hands back a Date at local midnight, so the UTC slice would be the wrong day in a negative offset. */
const toDay = (value: unknown): string => {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  return String(value).slice(0, 10);
};
/** A `time` column as "HH:MM". */
const toTimeOfDay = (value: unknown): string => String(value).slice(0, 5);

const auditActor = (actor: Actor): AuditActor =>
  actor.kind === "job" ? { kind: "system", id: null } : { kind: actor.kind, id: actor.id };

/**
 * The edition's reporting schedule, assembled from the records that already
 * own each part rather than from a copy of its own: the window from
 * `hq_hackathons.start_date`/`end_date` (what an admin sets for the edition),
 * the timezone from `hq_settings` (the campaign timezone every other
 * time-of-day read uses), and the final-period start plus nudge settings from
 * `hq_reporting_config`. Nothing here comes from Colosseum: Colosseum's own
 * `projectSubmissionEndDate` is a separate, external deadline, stored beside
 * this as `official_submission_deadline` when it differs, and it never moves
 * HQ's reporting window.
 *
 * Null for an edition that does not exist. An edition with no reporting
 * configuration row still has a schedule: a purely weekly one over its own
 * dates, with the column defaults for the nudge.
 */
export async function readReportingSchedule(db: BuilderQuery, hackathonId: number): Promise<ReportingSchedule | null> {
  const { rows } = await db.query(
    `SELECT h.start_date, h.end_date,
       COALESCE((SELECT s.value #>> '{}' FROM hq_settings s WHERE s.hackathon_id = h.id AND s.key = 'timezone'), $2) AS timezone,
       c.final_period_start_date, c.nudge_weekday, c.nudge_time
     FROM hq_hackathons h LEFT JOIN hq_reporting_config c ON c.hackathon_id = h.id
     WHERE h.id = $1`,
    [hackathonId, DEFAULT_TIMEZONE],
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    startDate: toDay(row.start_date),
    endDate: toDay(row.end_date),
    timezone: String(row.timezone || DEFAULT_TIMEZONE),
    finalPeriodStartDate: row.final_period_start_date == null ? null : toDay(row.final_period_start_date),
    nudgeWeekday: row.nudge_weekday == null ? DEFAULT_NUDGE_WEEKDAY : Number(row.nudge_weekday),
    nudgeTime: row.nudge_time == null ? DEFAULT_NUDGE_TIME : toTimeOfDay(row.nudge_time),
  };
}

/** A stored reporting period: the generated window plus its row identity and closure state. */
export type ReportingPeriod = GeneratedPeriod & {
  id: string;
  hackathonId: number;
  closedAt: string | null;
};

const toPeriod = (row: Record<string, unknown>): ReportingPeriod => ({
  id: String(row.id),
  hackathonId: Number(row.hackathon_id),
  sequence: Number(row.sequence),
  mode: row.mode as ReportingPeriodMode,
  startDate: toDay(row.start_date),
  endDate: toDay(row.end_date),
  startsAt: toIso(row.starts_at),
  endsAt: toIso(row.ends_at),
  nudgeAt: row.nudge_at == null ? null : toIso(row.nudge_at),
  closedAt: row.closed_at == null ? null : toIso(row.closed_at),
});

const PERIOD_COLUMNS = "id::text AS id, hackathon_id, sequence, mode, start_date, end_date, starts_at, ends_at, nudge_at, closed_at";

/** The edition's stored periods, in order. Read-only: nothing is generated here. */
export async function listReportingPeriods(db: BuilderQuery, hackathonId: number): Promise<ReportingPeriod[]> {
  const { rows } = await db.query(`SELECT ${PERIOD_COLUMNS} FROM hq_reporting_periods WHERE hackathon_id = $1 ORDER BY sequence`, [hackathonId]);
  return rows.map(toPeriod);
}

/** The stored period an instant falls in, or null outside the campaign. The end is exclusive. */
export async function currentReportingPeriod(db: BuilderQuery, hackathonId: number, atMs: number = Date.now()): Promise<ReportingPeriod | null> {
  return periodForInstant(await listReportingPeriods(db, hackathonId), atMs);
}

/**
 * Why a stored period could not be moved to match the regenerated schedule.
 * `has_entries` and `has_outcomes`: people have already reported against it,
 * so relabelling it would silently move their week. `closed`: its outcomes
 * are history.
 */
export type ReportingPeriodConflictReason = "has_entries" | "has_outcomes" | "closed";

export type ReportingPeriodConflict = {
  periodId: string;
  sequence: number;
  reason: ReportingPeriodConflictReason;
  storedStartDate: string;
  storedEndDate: string;
  /** What the current schedule says this period would be, or null when the schedule no longer has a period at this sequence. */
  generatedStartDate: string | null;
  generatedEndDate: string | null;
  entries: number;
  outcomes: number;
};

export type ReportingPeriodPlan = {
  /** The periods as they stand (after the write, for `ensureReportingPeriods`; unchanged, for the preview). */
  periods: ReportingPeriod[];
  added: number;
  updated: number;
  removed: number;
  /** Stored periods the change would have moved or dropped but must not. Show these to an admin before a live schedule change. */
  conflicts: ReportingPeriodConflict[];
};

type StoredPeriod = ReportingPeriod & { entries: number; outcomes: number };

async function storedPeriods(db: BuilderQuery, hackathonId: number): Promise<StoredPeriod[]> {
  const { rows } = await db.query(
    `SELECT ${PERIOD_COLUMNS},
       (SELECT count(*) FROM hq_reporting_entries e WHERE e.period_id = p.id) AS entries,
       (SELECT count(*) FROM hq_reporting_outcomes o WHERE o.period_id = p.id) AS outcomes
     FROM hq_reporting_periods p WHERE hackathon_id = $1 ORDER BY sequence`,
    [hackathonId],
  );
  return rows.map((row) => ({ ...toPeriod(row), entries: Number(row.entries ?? 0), outcomes: Number(row.outcomes ?? 0) }));
}

/** A stored period nobody has reported against and that is not closed may be moved; anything else is history. */
function lockReason(period: StoredPeriod): ReportingPeriodConflictReason | null {
  if (period.closedAt) return "closed";
  if (period.entries > 0) return "has_entries";
  if (period.outcomes > 0) return "has_outcomes";
  return null;
}

const sameWindow = (stored: ReportingPeriod, generated: GeneratedPeriod) =>
  stored.mode === generated.mode && stored.startDate === generated.startDate && stored.endDate === generated.endDate
  && stored.startsAt === generated.startsAt && stored.endsAt === generated.endsAt && stored.nudgeAt === generated.nudgeAt;

const conflictOf = (stored: StoredPeriod, reason: ReportingPeriodConflictReason, generated: GeneratedPeriod | undefined): ReportingPeriodConflict => ({
  periodId: stored.id, sequence: stored.sequence, reason,
  storedStartDate: stored.startDate, storedEndDate: stored.endDate,
  generatedStartDate: generated?.startDate ?? null, generatedEndDate: generated?.endDate ?? null,
  entries: stored.entries, outcomes: stored.outcomes,
});

/**
 * What reconciling the stored periods with the current schedule would do.
 * A period is matched to a generated one by `sequence`, never by its dates:
 * that is what makes the generator's determinism worth having, and what stops
 * a one-day shift in the campaign window from being read as "every period was
 * deleted and four new ones created".
 */
function planPeriods(stored: StoredPeriod[], generated: GeneratedPeriod[]) {
  const bySequence = new Map(generated.map((period) => [period.sequence, period]));
  const add = generated.filter((period) => !stored.some((row) => row.sequence === period.sequence));
  const update: { stored: StoredPeriod; generated: GeneratedPeriod }[] = [];
  const remove: StoredPeriod[] = [];
  const conflicts: ReportingPeriodConflict[] = [];
  for (const row of stored) {
    const match = bySequence.get(row.sequence);
    const locked = lockReason(row);
    if (!match) {
      if (locked) conflicts.push(conflictOf(row, locked, undefined));
      else remove.push(row);
      continue;
    }
    if (sameWindow(row, match)) continue;
    if (locked) conflicts.push(conflictOf(row, locked, match));
    else update.push({ stored: row, generated: match });
  }
  return { add, update, remove, conflicts };
}

/** The read-only half of `ensureReportingPeriods`: what a live schedule change would do, for the admin confirmation the plan requires. */
export async function previewReportingPeriods(db: BuilderQuery, hackathonId: number): Promise<ReportingPeriodPlan> {
  const schedule = await readReportingSchedule(db, hackathonId);
  const stored = await storedPeriods(db, hackathonId);
  const plan = planPeriods(stored, schedule ? generateReportingPeriods(schedule) : []);
  return { periods: stored.map(({ entries: _entries, outcomes: _outcomes, ...period }) => period), added: plan.add.length, updated: plan.update.length, removed: plan.remove.length, conflicts: plan.conflicts };
}

/**
 * Brings the edition's stored periods in line with its schedule, in one
 * transaction, and returns them.
 *
 * Idempotent: a second call with an unchanged schedule writes nothing. A
 * period that already holds an entry or an outcome, or that has been closed,
 * is never moved or removed — it is returned as a conflict instead, so an
 * admin sees which weeks a date edit would have relabelled rather than
 * discovering it afterwards in the history.
 */
export async function ensureReportingPeriods(db: BuilderDatabase | BuilderQuery, hackathonId: number): Promise<ReportingPeriodPlan> {
  return atomically(db, async (tx) => {
    const schedule = await readReportingSchedule(tx, hackathonId);
    if (!schedule) return { periods: [], added: 0, updated: 0, removed: 0, conflicts: [] };
    const plan = planPeriods(await storedPeriods(tx, hackathonId), generateReportingPeriods(schedule));
    for (const period of plan.add) {
      await tx.query(
        `INSERT INTO hq_reporting_periods (hackathon_id, sequence, mode, start_date, end_date, starts_at, ends_at, nudge_at)
         VALUES ($1,$2,$3,$4::date,$5::date,$6::timestamptz,$7::timestamptz,$8::timestamptz)
         ON CONFLICT (hackathon_id, sequence) DO NOTHING`,
        [hackathonId, period.sequence, period.mode, period.startDate, period.endDate, period.startsAt, period.endsAt, period.nudgeAt],
      );
    }
    for (const { stored, generated } of plan.update) {
      await tx.query(
        `UPDATE hq_reporting_periods SET mode=$2, start_date=$3::date, end_date=$4::date, starts_at=$5::timestamptz, ends_at=$6::timestamptz, nudge_at=$7::timestamptz
         WHERE id=$1::uuid AND closed_at IS NULL`,
        [stored.id, generated.mode, generated.startDate, generated.endDate, generated.startsAt, generated.endsAt, generated.nudgeAt],
      );
    }
    for (const period of plan.remove) {
      await tx.query("DELETE FROM hq_reporting_periods WHERE id=$1::uuid AND closed_at IS NULL", [period.id]);
    }
    return {
      periods: await listReportingPeriods(tx, hackathonId),
      added: plan.add.length, updated: plan.update.length, removed: plan.remove.length, conflicts: plan.conflicts,
    };
  });
}

/**
 * A project's place in reporting. `imported` and `projectName` come from the
 * project itself, so a caller never has to look up an onboarding row that may
 * not exist just to label the row it is about to show.
 */
export type ReportingEligibility = {
  projectId: string;
  projectName: string;
  hackathonId: number;
  imported: boolean;
  /** The instant reporting began for this project. No missed week is ever recorded before it. */
  eligibleFrom: string;
  /** Paused by an admin: future periods stop counting, closed outcomes stay exactly as recorded. */
  paused: boolean;
  pausedAt: string | null;
};

const ELIGIBILITY_SELECT =
  `SELECT e.project_id::text AS project_id, p.name AS project_name, e.hackathon_id,
     EXISTS (SELECT 1 FROM hq_project_onboarding o WHERE o.project_id = e.project_id) AS imported,
     e.eligible_from, e.paused_at
   FROM hq_reporting_eligibility e JOIN hq_projects p ON p.id = e.project_id`;

const toEligibility = (row: Record<string, unknown>): ReportingEligibility => ({
  projectId: String(row.project_id),
  projectName: String(row.project_name),
  hackathonId: Number(row.hackathon_id),
  imported: Boolean(row.imported),
  eligibleFrom: toIso(row.eligible_from),
  paused: row.paused_at != null,
  pausedAt: row.paused_at == null ? null : toIso(row.paused_at),
});

export async function reportingEligibility(db: BuilderQuery, projectId: string): Promise<ReportingEligibility | null> {
  const { rows } = await db.query(`${ELIGIBILITY_SELECT} WHERE e.project_id = $1::uuid`, [projectId]);
  return rows.length ? toEligibility(rows[0]) : null;
}

/** Every project currently in reporting for the edition, paused ones included (a pause is a state, not a removal). */
export async function listReportingEligibility(db: BuilderQuery, hackathonId: number): Promise<ReportingEligibility[]> {
  const { rows } = await db.query(`${ELIGIBILITY_SELECT} WHERE e.hackathon_id = $1 ORDER BY p.name`, [hackathonId]);
  return rows.map(toEligibility);
}

export type ReportingEligibilityResult =
  | { ok: true; created: boolean; eligibility: ReportingEligibility }
  | { ok: false; reason: "not_found" };

/**
 * Puts a project into reporting: on a successful self-service import (the
 * member is the actor and no audit event is written, because the import's own
 * `project.imported` event already records it), or when an admin explicitly
 * enables an existing manually tracked project (`operatorId` is set and the
 * change is audited).
 *
 * Idempotent, and it never moves an existing `eligible_from`: re-enabling a
 * project that was already in reporting must not erase the weeks it was
 * already accountable for. Resuming a paused project clears the pause and
 * leaves the original start alone, for the same reason.
 *
 * Entering reporting is also what makes the edition's schedule exist ("store
 * period identities once reporting begins"), so the first team in an edition
 * brings its periods with it.
 */
export async function enableReporting(
  db: BuilderDatabase | BuilderQuery,
  input: { projectId: string; hackathonId: number; actor: Actor; operatorId?: string },
): Promise<ReportingEligibilityResult> {
  return atomically(db, async (tx) => {
    const { rows: project } = await tx.query("SELECT id::text AS id FROM hq_projects WHERE id = $1::uuid AND hackathon_id = $2", [input.projectId, input.hackathonId]);
    if (!project.length) return { ok: false, reason: "not_found" };
    const { rows: inserted } = await tx.query(
      `INSERT INTO hq_reporting_eligibility (project_id, hackathon_id, enabled_by_user_id)
       VALUES ($1::uuid, $2, $3::uuid)
       ON CONFLICT (project_id) DO UPDATE SET paused_at = NULL, updated_at = now()
       RETURNING (xmax = 0) AS created`,
      [input.projectId, input.hackathonId, input.operatorId ?? null],
    );
    const created = Boolean(inserted[0]?.created);
    await ensureReportingPeriods(tx, input.hackathonId);
    if (input.operatorId) {
      await recordAuditEvent(tx, {
        kind: "reporting.eligibility_changed",
        actor: auditActor(input.actor),
        hackathonId: input.hackathonId,
        projectId: input.projectId,
        metadata: { enabled: true, created, paused: false },
      });
    }
    const eligibility = await reportingEligibility(tx, input.projectId);
    return eligibility ? { ok: true, created, eligibility } : { ok: false, reason: "not_found" };
  });
}

/**
 * Pauses or resumes a project's future reporting. A pause never removes a
 * closed outcome: the plan's "Admins can pause future reporting without
 * deleting past outcomes" is met by the pause being a state on the
 * eligibility row that `reportingStatus` and `closePeriod` read, and by
 * neither of them ever rewriting a period that is already closed.
 */
export async function pauseReporting(
  db: BuilderDatabase | BuilderQuery,
  input: { projectId: string; hackathonId: number; paused: boolean; operatorId: string; actor: Actor; reason?: string },
): Promise<ReportingEligibilityResult> {
  return atomically(db, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE hq_reporting_eligibility SET paused_at = CASE WHEN $3 THEN COALESCE(paused_at, now()) ELSE NULL END, updated_at = now()
       WHERE project_id = $1::uuid AND hackathon_id = $2 RETURNING project_id`,
      [input.projectId, input.hackathonId, input.paused],
    );
    if (!rows.length) return { ok: false, reason: "not_found" };
    await recordAuditEvent(tx, {
      kind: "reporting.eligibility_changed",
      actor: auditActor(input.actor),
      hackathonId: input.hackathonId,
      projectId: input.projectId,
      metadata: { enabled: !input.paused, paused: input.paused, ...(input.reason ? { reason: input.reason } : {}) },
    });
    const eligibility = await reportingEligibility(tx, input.projectId);
    return eligibility ? { ok: true, created: false, eligibility } : { ok: false, reason: "not_found" };
  });
}

/** The builder-side pool, so a caller can reach the service without building a handle of its own. */
export const reportingDatabase = builderDatabase;
