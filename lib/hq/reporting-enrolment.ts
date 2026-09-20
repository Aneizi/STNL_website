import "server-only";
import { recordAuditEvent } from "./audit";
import { atomically, type BuilderDatabase, type BuilderQuery } from "./builder-db";
import { BuilderError } from "./builder-types";
import {
  generateReportingPeriods,
  periodForInstant,
  type GeneratedPeriod,
  type ReportingPeriodMode,
  type ReportingSchedule,
} from "./reporting-periods";

/** Session-free schedule and enrolment operations; imports reuse their transaction to enrol teams atomically. */

/** The campaign timezone when an edition has no `timezone` setting of its own; matches SETTINGS_FALLBACK in ./queries. */
const DEFAULT_TIMEZONE = "Europe/Amsterdam";
/** ISO weekday 3, Wednesday: the plan's mid-period nudge day, and the column default. */
const DEFAULT_NUDGE_WEEKDAY = 3;
const DEFAULT_NUDGE_TIME = "12:00";

/**
 * Optional per-edition launch setting in hq_settings. It controls when
 * updates become required without renumbering the hackathon's weeks.
 * The SQL references are internal constants, never user input.
 */
const configuredReportingStartSql = (edition: "$2" | "e.hackathon_id") => `(
  SELECT (s.value #>> '{}')::date::timestamp AT TIME ZONE
    COALESCE((SELECT t.value #>> '{}' FROM hq_settings t WHERE t.hackathon_id = ${edition} AND t.key = 'timezone'), '${DEFAULT_TIMEZONE}')
  FROM hq_settings s WHERE s.hackathon_id = ${edition} AND s.key = 'reporting_start_date'
)`;

export const toIso = (value: unknown) => (value instanceof Date ? value : new Date(String(value))).toISOString();
/** A `date` column as an ISO day. The pg driver hands back a Date at local midnight, so the UTC slice would be the wrong day in a negative offset. */
export const toDay = (value: unknown): string => {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  return String(value).slice(0, 10);
};
/** A `time` column as "HH:MM". */
const toTimeOfDay = (value: unknown): string => String(value).slice(0, 5);


/**
 * HQ dates and timezone define the reporting window. Colosseum's separate
 * submission deadline never moves it. Missing configuration defaults to weekly.
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

/** Read stored settings without merging the schedule; missing rows return defaults with stored: false. */
export type ReportingConfig = {
  hackathonId: number;
  /** The local day the submission-focus period starts on, or null for a purely weekly schedule. */
  finalPeriodStartDate: string | null;
  /** Colosseum's own deadline when an admin has recorded one. Never read from Colosseum here. */
  officialSubmissionDeadline: string | null;
  /** Preserve whether the deadline came from an admin or Colosseum. */
  officialDeadlineSource: "admin" | "colosseum" | null;
  /** When the deadline was last read from Colosseum, whatever the outcome of that read. */
  officialDeadlineCheckedAt: string | null;
  /** The material keys this edition requires, as an admin recorded them. Empty means nothing is known to be required. */
  requiredMaterials: string[];
  /** The material keys this edition offers but does not require. Anything in neither list is Unknown. */
  optionalMaterials: string[];
  /** How stale a snapshot may get during the final period before the job re-reads it, or null for no automatic refresh. */
  submissionRefreshMinutes: number | null;
  nudgeWeekday: number;
  nudgeTime: string;
  /** Whether a row exists, so a screen can say "not set yet" rather than showing a default as a decision. */
  stored: boolean;
};

const CONFIG_COLUMNS =
  "hackathon_id, final_period_start_date, official_submission_deadline, official_deadline_source, official_deadline_checked_at, "
  + "required_materials, optional_materials, submission_refresh_minutes, nudge_weekday, nudge_time";

/** A `text[]` column as a string list, tolerating the driver handing back a JSON-ish string rather than an array. */
const toKeyList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.startsWith("{")) {
    return value.slice(1, -1).split(",").map((entry) => entry.replace(/^"|"$/g, "")).filter(Boolean);
  }
  return [];
};

const toConfig = (hackathonId: number, row: Record<string, unknown> | undefined): ReportingConfig => ({
  hackathonId,
  finalPeriodStartDate: row?.final_period_start_date == null ? null : toDay(row.final_period_start_date),
  officialSubmissionDeadline: row?.official_submission_deadline == null ? null : toIso(row.official_submission_deadline),
  officialDeadlineSource: row?.official_deadline_source === "colosseum" ? "colosseum" : row?.official_deadline_source === "admin" ? "admin" : null,
  officialDeadlineCheckedAt: row?.official_deadline_checked_at == null ? null : toIso(row.official_deadline_checked_at),
  requiredMaterials: toKeyList(row?.required_materials),
  optionalMaterials: toKeyList(row?.optional_materials),
  submissionRefreshMinutes: row?.submission_refresh_minutes == null ? null : Number(row.submission_refresh_minutes),
  nudgeWeekday: row?.nudge_weekday == null ? DEFAULT_NUDGE_WEEKDAY : Number(row.nudge_weekday),
  nudgeTime: row?.nudge_time == null ? DEFAULT_NUDGE_TIME : toTimeOfDay(row.nudge_time),
  stored: row != null,
});

export async function readReportingConfig(db: BuilderQuery, hackathonId: number): Promise<ReportingConfig> {
  const { rows } = await db.query(`SELECT ${CONFIG_COLUMNS} FROM hq_reporting_config WHERE hackathon_id = $1`, [hackathonId]);
  return toConfig(hackathonId, rows[0]);
}

/** Save configuration separately from applying period changes, so existing reporting history can be protected. */
export async function writeReportingConfig(
  db: BuilderDatabase | BuilderQuery,
  input: {
    hackathonId: number;
    finalPeriodStartDate: string | null;
    officialSubmissionDeadline: string | null;
    nudgeWeekday: number;
    nudgeTime: string;
    /** Phase 10. Omitted keys keep whatever is stored, so the weekly form does not clear the submission settings. */
    requiredMaterials?: readonly string[];
    optionalMaterials?: readonly string[];
    submissionRefreshMinutes?: number | null;
  },
): Promise<ReportingConfig> {
  return atomically(db, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO hq_reporting_config (hackathon_id, final_period_start_date, official_submission_deadline, official_deadline_source,
         required_materials, optional_materials, submission_refresh_minutes, nudge_weekday, nudge_time)
       VALUES ($1, $2::date, $3::timestamptz, CASE WHEN $3::timestamptz IS NULL THEN NULL ELSE 'admin' END,
         COALESCE($6::text[], '{}'), COALESCE($7::text[], '{}'), $8, $4, $5::time)
       ON CONFLICT (hackathon_id) DO UPDATE SET
         final_period_start_date = EXCLUDED.final_period_start_date,
         official_submission_deadline = EXCLUDED.official_submission_deadline,
         -- Typing a deadline in makes an admin its source; clearing it clears
         -- the provenance too. Saving the form without touching the deadline
         -- leaves a value read from Colosseum attributed to Colosseum only if
         -- the instant is unchanged, which is what this comparison says.
         official_deadline_source = CASE
           WHEN EXCLUDED.official_submission_deadline IS NULL THEN NULL
           WHEN hq_reporting_config.official_submission_deadline IS NOT DISTINCT FROM EXCLUDED.official_submission_deadline
             THEN hq_reporting_config.official_deadline_source
           ELSE 'admin' END,
         required_materials = COALESCE($6::text[], hq_reporting_config.required_materials),
         optional_materials = COALESCE($7::text[], hq_reporting_config.optional_materials),
         submission_refresh_minutes = CASE WHEN $9 THEN $8 ELSE hq_reporting_config.submission_refresh_minutes END,
         nudge_weekday = EXCLUDED.nudge_weekday,
         nudge_time = EXCLUDED.nudge_time,
         updated_at = now()
       RETURNING ${CONFIG_COLUMNS}`,
      [
        input.hackathonId, input.finalPeriodStartDate, input.officialSubmissionDeadline, input.nudgeWeekday, input.nudgeTime,
        input.requiredMaterials ? [...input.requiredMaterials] : null,
        input.optionalMaterials ? [...input.optionalMaterials] : null,
        input.submissionRefreshMinutes ?? null,
        input.submissionRefreshMinutes !== undefined,
      ],
    );
    return toConfig(input.hackathonId, rows[0]);
  });
}

/** Stamp successful source reads even without a deadline; a missing source deadline must not erase an admin value. */
export async function recordColosseumDeadline(
  db: BuilderDatabase | BuilderQuery,
  input: { hackathonId: number; deadline: string | null; checkedAt: string },
): Promise<ReportingConfig> {
  return atomically(db, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO hq_reporting_config (hackathon_id, official_submission_deadline, official_deadline_source, official_deadline_checked_at)
       VALUES ($1, $2::timestamptz, CASE WHEN $2::timestamptz IS NULL THEN NULL ELSE 'colosseum' END, $3::timestamptz)
       ON CONFLICT (hackathon_id) DO UPDATE SET
         official_submission_deadline = COALESCE(EXCLUDED.official_submission_deadline, hq_reporting_config.official_submission_deadline),
         official_deadline_source = CASE WHEN EXCLUDED.official_submission_deadline IS NULL
           THEN hq_reporting_config.official_deadline_source ELSE 'colosseum' END,
         official_deadline_checked_at = EXCLUDED.official_deadline_checked_at,
         updated_at = now()
       RETURNING ${CONFIG_COLUMNS}`,
      [input.hackathonId, input.deadline, input.checkedAt],
    );
    return toConfig(input.hackathonId, rows[0]);
  });
}

/** A stored reporting period: the generated window plus its row identity and closure state. */
export type ReportingPeriod = GeneratedPeriod & {
  id: string;
  hackathonId: number;
  closedAt: string | null;
};

export const toPeriod = (row: Record<string, unknown>): ReportingPeriod => ({
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

/** Qualify period columns when joins would make their names ambiguous. */
export const periodColumns = (alias = ""): string => {
  const p = alias ? `${alias}.` : "";
  return `${p}id::text AS id, ${p}hackathon_id, ${p}sequence, ${p}mode, ${p}start_date, ${p}end_date, ${p}starts_at, ${p}ends_at, ${p}nudge_at, ${p}closed_at`;
};

export const PERIOD_COLUMNS = periodColumns();

/** The edition's stored periods, in order. Read-only: nothing is generated here. */
export async function listReportingPeriods(db: BuilderQuery, hackathonId: number): Promise<ReportingPeriod[]> {
  const { rows } = await db.query(`SELECT ${PERIOD_COLUMNS} FROM hq_reporting_periods WHERE hackathon_id = $1 ORDER BY sequence`, [hackathonId]);
  return rows.map(toPeriod);
}

/** The stored period an instant falls in, or null outside the campaign. The end is exclusive. */
export async function currentReportingPeriod(db: BuilderQuery, hackathonId: number, atMs: number = Date.now()): Promise<ReportingPeriod | null> {
  return periodForInstant(await listReportingPeriods(db, hackathonId), atMs);
}

/** Entries, outcomes, and closed periods protect historical weeks from being moved or removed. */
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

/** Invalid schedule boundaries, identified by the affected pair of weeks. */
export type ReportingScheduleProblem = {
  kind: "gap" | "overlap" | "missing_sequence";
  /** The earlier of the two weeks, or 0 when the numbering itself is wrong from the start. */
  sequence: number;
  /** The last day of the earlier week and the first day of the later one, for the sentence an admin reads. */
  beforeEndDate: string | null;
  afterStartDate: string | null;
};

export type ReportingPeriodPlan = {
  /** The periods as they stand (after the write, for `ensureReportingPeriods`; unchanged, for the preview). */
  periods: ReportingPeriod[];
  added: number;
  updated: number;
  removed: number;
  /** Stored periods the change would have moved or dropped but must not. Show these to an admin before a live schedule change. */
  conflicts: ReportingPeriodConflict[];
  /** A refused change still reports proposed counts so the admin can inspect what was blocked. */
  blocked: boolean;
  /** Why it was refused. Empty whenever `blocked` is false. */
  problems: ReportingScheduleProblem[];
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

/** Recheck protection inside UPDATE/DELETE, not only in the earlier reconciliation calculation. */
const UNREPORTED_PERIOD =
  "NOT EXISTS (SELECT 1 FROM hq_reporting_entries e WHERE e.period_id = hq_reporting_periods.id)"
  + " AND NOT EXISTS (SELECT 1 FROM hq_reporting_outcomes o WHERE o.period_id = hq_reporting_periods.id)";

const RECONCILE_RACE = "Someone reported against a week while the schedule was being applied. Nothing was changed. Look at the weeks again and apply once more.";

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

/** Match by stable sequence; shifting dates must not replace every period's identity. */
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

/** Validate the complete resulting schedule, including protected periods that retain their old dates. */
type ProjectedPeriod = { sequence: number; startDate: string; endDate: string; startsAt: string; endsAt: string };

function projectSchedule(stored: StoredPeriod[], plan: ReturnType<typeof planPeriods>): ProjectedPeriod[] {
  const moved = new Map(plan.update.map(({ stored: row, generated }) => [row.id, generated]));
  const dropped = new Set(plan.remove.map((row) => row.id));
  const kept: ProjectedPeriod[] = [];
  for (const row of stored) {
    if (dropped.has(row.id)) continue;
    const to = moved.get(row.id) ?? row;
    kept.push({ sequence: row.sequence, startDate: to.startDate, endDate: to.endDate, startsAt: to.startsAt, endsAt: to.endsAt });
  }
  for (const period of plan.add) {
    kept.push({ sequence: period.sequence, startDate: period.startDate, endDate: period.endDate, startsAt: period.startsAt, endsAt: period.endsAt });
  }
  return kept.sort((a, b) => a.sequence - b.sequence);
}

/**
 * Reject the entire change if retained and regenerated periods would leave
 * gaps, overlaps, or missing sequence numbers. Individually safe edits can
 * still produce an invalid combined schedule.
 */
function scheduleProblems(periods: ProjectedPeriod[]): ReportingScheduleProblem[] {
  const problems: ReportingScheduleProblem[] = [];
  periods.forEach((period, index) => {
    if (period.sequence !== index + 1) {
      problems.push({ kind: "missing_sequence", sequence: index === 0 ? 0 : periods[index - 1].sequence, beforeEndDate: index === 0 ? null : periods[index - 1].endDate, afterStartDate: period.startDate });
      return;
    }
    if (index === 0) return;
    const previous = periods[index - 1];
    const ends = Date.parse(previous.endsAt);
    const starts = Date.parse(period.startsAt);
    if (ends === starts) return;
    problems.push({
      kind: ends < starts ? "gap" : "overlap",
      sequence: previous.sequence,
      beforeEndDate: previous.endDate,
      afterStartDate: period.startDate,
    });
  });
  return problems;
}

/** The plan, with the schedule it would leave behind already judged. Shared by the preview and the write so the two can never disagree. */
function judgePlan(stored: StoredPeriod[], generated: GeneratedPeriod[]) {
  const plan = planPeriods(stored, generated);
  const changes = plan.add.length + plan.update.length + plan.remove.length;
  // A no-op reconciliation is never refused: an edition whose stored weeks
  // are already discontinuous (nothing here can produce that, but a hand-run
  // statement could) must not stop every later enrolment from working.
  const problems = changes ? scheduleProblems(projectSchedule(stored, plan)) : [];
  return { ...plan, changes, problems, blocked: problems.length > 0 };
}

const withoutCounts = (stored: StoredPeriod[]): ReportingPeriod[] =>
  stored.map(({ entries: _entries, outcomes: _outcomes, ...period }) => period);

/** The read-only half of `ensureReportingPeriods`: what a live schedule change would do, for the admin confirmation the plan requires. */
export async function previewReportingPeriods(db: BuilderQuery, hackathonId: number): Promise<ReportingPeriodPlan> {
  const schedule = await readReportingSchedule(db, hackathonId);
  const stored = await storedPeriods(db, hackathonId);
  const plan = judgePlan(stored, schedule ? generateReportingPeriods(schedule) : []);
  return {
    periods: withoutCounts(stored),
    added: plan.add.length, updated: plan.update.length, removed: plan.remove.length,
    conflicts: plan.conflicts, blocked: plan.blocked, problems: plan.problems,
  };
}

/** Reconcile atomically and idempotently; reported or closed periods remain untouched and surface as conflicts. */
export async function ensureReportingPeriods(db: BuilderDatabase | BuilderQuery, hackathonId: number): Promise<ReportingPeriodPlan> {
  return atomically(db, async (tx) => {
    // The first statement, before anything is read or decided: every one of
    // this edition's period rows, locked in sequence order for the rest of
    // the transaction.
    //
    // Without it, counting a period's entries and then deleting the period
    // are two separate moments with a window between them. An entry saved in
    // that window is inserted against a row this transaction has already
    // decided is empty, and the delete then takes it, and its revision
    // history, out with the period through the foreign keys. The lock closes
    // the window at the database rather than in the arithmetic: an insert
    // into `hq_reporting_entries` needs a KEY SHARE lock on the period row it
    // references, which this FOR UPDATE holds, so a concurrent save either
    // commits before the counts below are read (and the period comes back as
    // a conflict) or waits, finds the row gone and refuses. `createUpdate`
    // takes the matching FOR SHARE on its chosen period for the same reason.
    //
    // Sequence order keeps two concurrent reconciliations of one edition
    // deadlock free between themselves; `closePeriod` locks a single period
    // row and reaches for nothing this holds, so there is no cycle with it.
    await tx.query("SELECT id FROM hq_reporting_periods WHERE hackathon_id = $1 ORDER BY sequence FOR UPDATE", [hackathonId]);
    const schedule = await readReportingSchedule(tx, hackathonId);
    if (!schedule) return { periods: [], added: 0, updated: 0, removed: 0, conflicts: [], blocked: false, problems: [] };
    const stored = await storedPeriods(tx, hackathonId);
    const plan = judgePlan(stored, generateReportingPeriods(schedule));
    const counts = { added: plan.add.length, updated: plan.update.length, removed: plan.remove.length };
    // Refused as a whole, not week by week: see `scheduleProblems`. The
    // proposed counts are still reported, because "this is the change that
    // was refused" is the sentence the admin screen has to write.
    if (plan.blocked) {
      return { periods: withoutCounts(stored), ...counts, conflicts: plan.conflicts, blocked: true, problems: plan.problems };
    }
    for (const period of plan.add) {
      await tx.query(
        `INSERT INTO hq_reporting_periods (hackathon_id, sequence, mode, start_date, end_date, starts_at, ends_at, nudge_at)
         VALUES ($1,$2,$3,$4::date,$5::date,$6::timestamptz,$7::timestamptz,$8::timestamptz)
         ON CONFLICT (hackathon_id, sequence) DO NOTHING`,
        [hackathonId, period.sequence, period.mode, period.startDate, period.endDate, period.startsAt, period.endsAt, period.nudgeAt],
      );
    }
    // The same protection the plan applied, restated as a condition on the
    // write itself. Under the lock above these can no longer fail, and they
    // are still here: a period that holds reporting must not be moved or
    // removed by a schedule change, and that rule belongs in the statement
    // that would break it rather than only in the arithmetic that precedes
    // it. A guard that does fire means the lock was not held, so the
    // transaction is rolled back rather than left half applied.
    for (const { stored: row, generated } of plan.update) {
      const { rows } = await tx.query(
        `UPDATE hq_reporting_periods SET mode=$2, start_date=$3::date, end_date=$4::date, starts_at=$5::timestamptz, ends_at=$6::timestamptz, nudge_at=$7::timestamptz
         WHERE id=$1::uuid AND closed_at IS NULL AND ${UNREPORTED_PERIOD} RETURNING id`,
        [row.id, generated.mode, generated.startDate, generated.endDate, generated.startsAt, generated.endsAt, generated.nudgeAt],
      );
      if (!rows.length) throw new BuilderError(RECONCILE_RACE);
    }
    for (const period of plan.remove) {
      const { rows } = await tx.query(
        `DELETE FROM hq_reporting_periods WHERE id=$1::uuid AND closed_at IS NULL AND ${UNREPORTED_PERIOD} RETURNING id`,
        [period.id],
      );
      if (!rows.length) throw new BuilderError(RECONCILE_RACE);
    }
    return {
      periods: await listReportingPeriods(tx, hackathonId),
      ...counts, conflicts: plan.conflicts, blocked: false, problems: [],
    };
  });
}

/**
 * A project's place in reporting. `imported` and `projectName` come from the
 * project itself, so a caller never has to look up an onboarding row that may
 * not exist just to label the row it is about to show.
 */
/** Pause history prevents resuming from retroactively turning exempt weeks into missed updates. */
export type ReportingPause = { pausedAt: string; resumedAt: string | null };

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
  /** Every pause, oldest first, the open one included. What `accountable` in ./reporting reads. */
  pauses: ReportingPause[];
};

const ELIGIBILITY_SELECT =
  `SELECT e.project_id::text AS project_id, p.name AS project_name, e.hackathon_id,
     EXISTS (SELECT 1 FROM hq_project_onboarding o WHERE o.project_id = e.project_id) AS imported,
     GREATEST(e.eligible_from, ${configuredReportingStartSql("e.hackathon_id")}) AS eligible_from, e.paused_at,
     COALESCE((SELECT json_agg(json_build_object('pausedAt', i.paused_at, 'resumedAt', i.resumed_at) ORDER BY i.paused_at)
               FROM hq_reporting_pause_intervals i WHERE i.project_id = e.project_id), '[]'::json) AS pauses
   FROM hq_reporting_eligibility e JOIN hq_projects p ON p.id = e.project_id`;

/** The aggregated pause rows, whether the driver hands them back parsed or as text. */
const toPauses = (value: unknown): ReportingPause[] => {
  const rows = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row): row is { pausedAt: unknown; resumedAt: unknown } => row != null && typeof row === "object")
    .map((row) => ({ pausedAt: toIso(row.pausedAt), resumedAt: row.resumedAt == null ? null : toIso(row.resumedAt) }));
};

const toEligibility = (row: Record<string, unknown>): ReportingEligibility => ({
  projectId: String(row.project_id),
  projectName: String(row.project_name),
  hackathonId: Number(row.hackathon_id),
  imported: Boolean(row.imported),
  eligibleFrom: toIso(row.eligible_from),
  paused: row.paused_at != null,
  pausedAt: row.paused_at == null ? null : toIso(row.paused_at),
  pauses: toPauses(row.pauses),
});

export async function reportingEligibility(db: BuilderQuery, projectId: string): Promise<ReportingEligibility | null> {
  const { rows } = await db.query(`${ELIGIBILITY_SELECT} WHERE e.project_id = $1::uuid`, [projectId]);
  return rows.length ? toEligibility(rows[0]) : null;
}

/** Every project currently in reporting for the edition, paused ones included (a pause is a state, not a removal). */
export async function listReportingEligibility(db: BuilderQuery, hackathonId: number, projectIds?: readonly string[]): Promise<ReportingEligibility[]> {
  if (projectIds && !projectIds.length) return [];
  const { rows } = await db.query(
    `${ELIGIBILITY_SELECT} WHERE e.hackathon_id = $1${projectIds ? " AND e.project_id = ANY($2::uuid[])" : ""} ORDER BY p.name`,
    projectIds ? [hackathonId, [...projectIds]] : [hackathonId],
  );
  return rows.map(toEligibility);
}

/** Ends the project's open pause, if it has one. Both ways out of a pause go through here so neither can leave the interval open. */
async function closeOpenPause(tx: BuilderQuery, input: { projectId: string; operatorId: string | null }): Promise<void> {
  await tx.query(
    "UPDATE hq_reporting_pause_intervals SET resumed_at = now(), resumed_by_user_id = $2::uuid WHERE project_id = $1::uuid AND resumed_at IS NULL",
    [input.projectId, input.operatorId],
  );
}

export type ReportingEligibilityResult =
  | { ok: true; created: boolean; eligibility: ReportingEligibility }
  | { ok: false; reason: "not_found" };

/**
 * Preserve the original eligible_from when enabling or resuming reporting.
 * Imports audit enrolment through project.imported; explicit operator changes
 * get their own event. The first enrolment also materializes the schedule.
 */
export async function enableReporting(
  db: BuilderDatabase | BuilderQuery,
  input: { projectId: string; hackathonId: number; operatorId?: string },
): Promise<ReportingEligibilityResult> {
  return atomically(db, async (tx) => {
    const { rows: project } = await tx.query("SELECT id::text AS id FROM hq_projects WHERE id = $1::uuid AND hackathon_id = $2", [input.projectId, input.hackathonId]);
    if (!project.length) return { ok: false, reason: "not_found" };
    const { rows: inserted } = await tx.query(
      `INSERT INTO hq_reporting_eligibility (project_id, hackathon_id, enabled_by_user_id, eligible_from)
       VALUES ($1::uuid, $2, $3::uuid, GREATEST(now(), ${configuredReportingStartSql("$2")}))
       ON CONFLICT (project_id) DO UPDATE SET paused_at = NULL, updated_at = now()
       RETURNING (xmax = 0) AS created`,
      [input.projectId, input.hackathonId, input.operatorId ?? null],
    );
    const created = Boolean(inserted[0]?.created);
    // Re-enabling is the other way out of a pause, so it closes the open
    // interval exactly as `pauseReporting` does. Leaving it open here would
    // exempt every week from now on from a pause that has ended.
    await closeOpenPause(tx, { projectId: input.projectId, operatorId: input.operatorId ?? null });
    await ensureReportingPeriods(tx, input.hackathonId);
    if (input.operatorId) {
      await recordAuditEvent(tx, {
        kind: "reporting.eligibility_changed",
        actor: { kind: "operator", id: input.operatorId },
        hackathonId: input.hackathonId,
        projectId: input.projectId,
        metadata: { enabled: true, created, paused: false },
      });
    }
    const eligibility = await reportingEligibility(tx, input.projectId);
    return eligibility ? { ok: true, created, eligibility } : { ok: false, reason: "not_found" };
  });
}

/** Pause future accountability without deleting or rewriting closed outcomes. */
export async function pauseReporting(
  db: BuilderDatabase | BuilderQuery,
  input: { projectId: string; hackathonId: number; paused: boolean; operatorId: string; reason?: string },
): Promise<ReportingEligibilityResult> {
  return atomically(db, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE hq_reporting_eligibility SET paused_at = CASE WHEN $3 THEN COALESCE(paused_at, now()) ELSE NULL END, updated_at = now()
       WHERE project_id = $1::uuid AND hackathon_id = $2 RETURNING project_id, paused_at`,
      [input.projectId, input.hackathonId, input.paused],
    );
    if (!rows.length) return { ok: false, reason: "not_found" };
    // The history twin of the column above, written in the same transaction:
    // the pause opens an interval at the same instant the column records, and
    // the resume closes it. Both are idempotent, so pausing an already paused
    // project opens no second interval and resuming a running one closes
    // nothing.
    if (input.paused) {
      await tx.query(
        `INSERT INTO hq_reporting_pause_intervals (project_id, hackathon_id, paused_at, paused_by_user_id, reason)
         SELECT $1::uuid, $2, $3::timestamptz, $4::uuid, $5
         WHERE NOT EXISTS (SELECT 1 FROM hq_reporting_pause_intervals i WHERE i.project_id = $1::uuid AND i.resumed_at IS NULL)`,
        [input.projectId, input.hackathonId, toIso(rows[0].paused_at), input.operatorId, input.reason ?? null],
      );
    } else {
      await closeOpenPause(tx, { projectId: input.projectId, operatorId: input.operatorId });
    }
    await recordAuditEvent(tx, {
      kind: "reporting.eligibility_changed",
      actor: { kind: "operator", id: input.operatorId },
      hackathonId: input.hackathonId,
      projectId: input.projectId,
      metadata: { enabled: !input.paused, paused: input.paused, ...(input.reason ? { reason: input.reason } : {}) },
    });
    const eligibility = await reportingEligibility(tx, input.projectId);
    return eligibility ? { ok: true, created: false, eligibility } : { ok: false, reason: "not_found" };
  });
}
