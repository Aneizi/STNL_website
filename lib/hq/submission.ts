import "server-only";
import type { ColosseumFetch } from "@/lib/colosseum-api";
import type { Actor } from "./actor";
import type { BuilderDatabase, BuilderQuery } from "./builder-db";
import { submittedOnTime, type SubmissionStatus } from "./colosseum-snapshot";
import { HQ_JOBS_AUDIENCE } from "./github-actions-auth";
import { refreshColosseumTeam } from "./project-import";
import {
  correctOutcome,
  readReportingConfig,
  toIso,
  type PeriodStatus,
} from "./reporting";
import { materialLinks, type SubmissionMaterialLinks } from "./submission-readiness";

/**
 * The final period's service (contracts.md's "Final submission" row,
 * implemented in phase 10): the submission snapshot each authorized surface
 * reads, the bounded server-side refresh, and the reconciliation that runs
 * when the submission period closes.
 *
 * Four rules the plan sets, and where each one lives.
 *
 * 1. **"Checklist readiness does not set Submitted. A confirmed official
 *    submission signal does."** Nothing here writes `submission_status`.
 *    `interpretSubmission` in ./colosseum-snapshot is still its only writer,
 *    reached through `refreshColosseumTeam`, and this module only ever reads
 *    the column back. A checklist is computed in ./submission-readiness,
 *    which is pure and cannot reach a database at all.
 * 2. **"Use bounded server-side refreshes during the final period if
 *    configured; do not poll Colosseum from every browser tab."**
 *    `dueSubmissionRefreshes` answers "which snapshots are stale RIGHT NOW",
 *    from stored configuration, the same shape phase 8's `dueReminders` uses;
 *    `refreshDueSubmissions` takes a bounded batch of them. It runs only when
 *    an admin has set an interval, and only while a submission period is
 *    open.
 * 3. **"At final closure, reconcile submission evidence where available. If
 *    the API is unavailable, preserve Not checked/stale information and flag
 *    reconciliation as pending internally; do not claim an unverified
 *    submission failure."** A closed submission period gets one
 *    `hq_submission_reconciliations` row per accountable imported project,
 *    `pending` until evidence arrives. A failed read increments `attempts`
 *    and records HQ's own error code; it never writes a status, and it never
 *    resolves.
 * 4. **"Historical corrections based on delayed authoritative evidence are
 *    audited. A submission made after the deadline remains late and does not
 *    erase an on-time failure."** Evidence of an ON-TIME submission for a
 *    week recorded as missed goes through `correctOutcome`, which writes the
 *    correction beside the original with a mandatory reason and an audit
 *    event. Evidence of a LATE submission is recorded and corrects nothing.
 *
 * It is reached from the operator Server Actions through ./jobs, so it must
 * stay clear of the public member auth graph (`tests/hq/operator-imports.test.ts`).
 * That is why the authorization for a member-facing read is done by the
 * CALLER (./reporting-surface, which already holds the decision) and not here:
 * everything below takes ids it has been given and answers about them.
 */

/** The reason recorded on an audited correction, so the audit trail says what the evidence was. */
const CORRECTION_REASON = (submittedAt: string) =>
  `Colosseum confirmed an on-time submission at ${submittedAt}, after this period closed.`;

/** How many stale snapshots one scheduled pass refreshes. Small on purpose: each one is an outbound request. */
export const SUBMISSION_REFRESH_BATCH = 5;
/** How many pending reconciliations one pass attempts, for the same reason. */
export const RECONCILE_BATCH = 5;
/**
 * How long a pass may spend on Colosseum before it stops and leaves the rest
 * for the next one. The job endpoint declares `maxDuration = 60` and shares it
 * with the reminder drain, so the submission half takes a slice rather than
 * the whole budget.
 */
const SOURCE_BUDGET_MS = 12_000;
// One Colosseum read times out after six seconds. Leave time to record its
// result before beginning another request or returning to the job runner.
const SOURCE_ATTEMPT_BUDGET_MS = 6_500;

/** One project's stored Colosseum snapshot, as every final-period surface reads it. */
export type ProjectSubmissionSnapshot = {
  projectId: string;
  projectUrl: string;
  submissionStatus: SubmissionStatus;
  submittedAt: string | null;
  links: SubmissionMaterialLinks;
  sourceStatus: "never" | "ok" | "error";
  sourceCheckedAt: string | null;
  /** HQ's own error code from the last failed read. Never Colosseum's own words, which stay for operators on the row. */
  sourceErrorCode: string | null;
};

const SNAPSHOT_COLUMNS = `project_id::text AS project_id, project_url, submission_status, submitted_at,
  presentation_link, pitch_video_link, technical_demo_link, demo_video_link, repo_link, website,
  source_status, source_checked_at, source_error_code`;

const text = (value: unknown): string | null => (value == null || value === "" ? null : String(value));

const toSnapshot = (row: Record<string, unknown>): ProjectSubmissionSnapshot => ({
  projectId: String(row.project_id),
  projectUrl: String(row.project_url),
  submissionStatus: (row.submission_status ?? "not_checked") as SubmissionStatus,
  submittedAt: row.submitted_at == null ? null : toIso(row.submitted_at),
  links: materialLinks({
    presentationLink: text(row.presentation_link),
    pitchVideoLink: text(row.pitch_video_link),
    technicalDemoLink: text(row.technical_demo_link),
    demoVideoLink: text(row.demo_video_link),
    repoLink: text(row.repo_link),
    website: text(row.website),
  }),
  sourceStatus: (row.source_status ?? "never") as ProjectSubmissionSnapshot["sourceStatus"],
  sourceCheckedAt: row.source_checked_at == null ? null : toIso(row.source_checked_at),
  sourceErrorCode: text(row.source_error_code),
});

/**
 * The stored snapshots for a set of projects, in one query rather than one
 * per card. A project with no Colosseum source behind it simply has no entry,
 * and a surface renders the rest of its card without one.
 */
export async function readSubmissionSnapshots(
  db: BuilderQuery,
  projectIds: readonly string[],
): Promise<Map<string, ProjectSubmissionSnapshot>> {
  const ids = [...new Set(projectIds)];
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `SELECT ${SNAPSHOT_COLUMNS} FROM hq_project_onboarding WHERE project_id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(rows.map((row) => [String(row.project_id), toSnapshot(row)]));
}

/**
 * Whether a period is the submission-focus one and is open at this instant.
 * The one comparison every surface makes, so "we are in the final period" is
 * not re-derived from a date anywhere.
 */
export const isOpenSubmissionPeriod = (period: PeriodStatus | null, atMs: number): boolean =>
  period != null && period.mode === "submission"
  && Date.parse(period.startsAt) <= atMs && atMs < Date.parse(period.endsAt);

/** The deadline a submission is judged against: the edition's recorded official one, else the period's own exclusive end. */
export const submissionDeadlineFor = (period: { endsAt: string }, officialDeadline: string | null): string =>
  officialDeadline ?? period.endsAt;

export type SubmissionReconciliation = {
  periodId: string;
  projectId: string;
  hackathonId: number;
  state: "pending" | "resolved";
  submissionStatus: SubmissionStatus | null;
  submittedAt: string | null;
  deadline: string | null;
  onTime: boolean | null;
  evidenceAt: string | null;
  attempts: number;
  lastError: string | null;
  outcomeCorrected: boolean;
  updatedAt: string;
};

const RECONCILE_COLUMNS = `period_id::text AS period_id, project_id::text AS project_id, hackathon_id, state,
  submission_status, submitted_at, deadline, on_time, evidence_at, attempts, last_error, outcome_corrected, updated_at`;

const toReconciliation = (row: Record<string, unknown>): SubmissionReconciliation => ({
  periodId: String(row.period_id),
  projectId: String(row.project_id),
  hackathonId: Number(row.hackathon_id),
  state: row.state === "resolved" ? "resolved" : "pending",
  submissionStatus: row.submission_status == null ? null : (String(row.submission_status) as SubmissionStatus),
  submittedAt: row.submitted_at == null ? null : toIso(row.submitted_at),
  deadline: row.deadline == null ? null : toIso(row.deadline),
  onTime: row.on_time == null ? null : Boolean(row.on_time),
  evidenceAt: row.evidence_at == null ? null : toIso(row.evidence_at),
  attempts: Number(row.attempts ?? 0),
  lastError: text(row.last_error),
  outcomeCorrected: Boolean(row.outcome_corrected),
  updatedAt: toIso(row.updated_at),
});

/** The reconciliations recorded for a set of projects, for a surface that shows one beside a week. */
export async function readSubmissionReconciliations(
  db: BuilderQuery,
  input: { projectIds: readonly string[]; periodId?: string },
): Promise<SubmissionReconciliation[]> {
  const ids = [...new Set(input.projectIds)];
  if (!ids.length) return [];
  const values: unknown[] = [ids];
  let period = "";
  if (input.periodId) {
    values.push(input.periodId);
    period = ` AND period_id = $${values.length}::uuid`;
  }
  const { rows } = await db.query(
    `SELECT ${RECONCILE_COLUMNS} FROM hq_submission_reconciliations WHERE project_id = ANY($1::uuid[])${period} ORDER BY updated_at DESC`,
    values,
  );
  return rows.map(toReconciliation);
}

/** The edition's reconciliations, newest first. Operator gated by its caller; this is a read, not a decision. */
export async function listSubmissionReconciliations(
  db: BuilderQuery,
  input: { hackathonId: number; limit?: number },
): Promise<SubmissionReconciliation[]> {
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 100)));
  const { rows } = await db.query(
    `SELECT ${RECONCILE_COLUMNS} FROM hq_submission_reconciliations WHERE hackathon_id = $1 ORDER BY updated_at DESC LIMIT $2`,
    [input.hackathonId, limit],
  );
  return rows.map(toReconciliation);
}

export type DueSubmissionRefresh = {
  projectId: string;
  hackathonId: number;
  projectUrl: string;
};

/**
 * Which imported projects' snapshots are stale enough to re-read, at this
 * instant, in editions whose submission period is open and whose admin has
 * set a refresh interval.
 *
 * Every clause is a decision the plan states. The interval comes from stored
 * configuration, so nothing runs on a deployment that has not asked for it.
 * The period must be the submission one and must be open, because this is the
 * final period's help and not a background poller. The project must be in
 * reporting and not paused, for the same reason a paused project gets no
 * reminder. And the order puts the projects with no confirmed submission
 * first, because those are the ones an answer would change something for.
 */
export async function dueSubmissionRefreshes(
  db: BuilderQuery,
  input: { atMs?: number; hackathonId?: number; limit?: number } = {},
): Promise<DueSubmissionRefresh[]> {
  const at = new Date(input.atMs ?? Date.now()).toISOString();
  const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? SUBMISSION_REFRESH_BATCH)));
  const values: unknown[] = [at, limit];
  let edition = "";
  if (input.hackathonId != null) {
    values.push(input.hackathonId);
    edition = ` AND p.hackathon_id = $${values.length}`;
  }
  const { rows } = await db.query(
    `SELECT o.project_id::text AS project_id, o.hackathon_id, o.project_url
     FROM hq_project_onboarding o
     JOIN hq_reporting_eligibility e ON e.project_id = o.project_id AND e.paused_at IS NULL
     JOIN hq_hackathons h ON h.id = o.hackathon_id AND h.archived_at IS NULL
     JOIN hq_reporting_config c ON c.hackathon_id = o.hackathon_id AND c.submission_refresh_minutes IS NOT NULL
     JOIN hq_reporting_periods p ON p.hackathon_id = o.hackathon_id AND p.mode = 'submission'
       AND p.closed_at IS NULL AND p.starts_at <= $1::timestamptz AND p.ends_at > $1::timestamptz
     WHERE e.eligible_from <= $1::timestamptz
       AND (GREATEST(o.source_attempted_at, o.source_checked_at) IS NULL
            OR GREATEST(o.source_attempted_at, o.source_checked_at) <= $1::timestamptz - make_interval(mins => c.submission_refresh_minutes))${edition}
     ORDER BY (o.submission_status = 'submitted'), GREATEST(o.source_attempted_at, o.source_checked_at) ASC NULLS FIRST, o.project_id
     LIMIT $2`,
    values,
  );
  return rows.map((row) => ({
    projectId: String(row.project_id),
    hackathonId: Number(row.hackathon_id),
    projectUrl: String(row.project_url),
  }));
}

export type SubmissionRefreshSummary = { attempted: number; refreshed: number; failed: number; stoppedOnBudget: boolean };

/**
 * Re-reads a bounded batch of stale snapshots.
 *
 * `refreshColosseumTeam` is phase 3's, untouched: it writes the snapshot and
 * the submission status on success and records the failure without changing
 * either on error, which is precisely "store verification timestamps and
 * retain last-known results on failure". Nothing is added here but the choice
 * of which projects and how many.
 */
export async function refreshDueSubmissions(
  db: BuilderQuery,
  input: { atMs?: number; hackathonId?: number; limit?: number; fetcher?: ColosseumFetch; deadlineMs?: number } = {},
): Promise<SubmissionRefreshSummary> {
  const due = await dueSubmissionRefreshes(db, input);
  const summary: SubmissionRefreshSummary = { attempted: 0, refreshed: 0, failed: 0, stoppedOnBudget: false };
  // The wall clock, not the injected instant: the budget is about how long
  // this invocation has really been running, which a fixed test instant says
  // nothing about.
  const deadlineMs = Math.min(input.deadlineMs ?? Infinity, Date.now() + SOURCE_BUDGET_MS);
  for (const project of due) {
    if (Date.now() + SOURCE_ATTEMPT_BUDGET_MS > deadlineMs) {
      summary.stoppedOnBudget = true;
      break;
    }
    summary.attempted += 1;
    const outcome = await refreshColosseumTeam(
      { projectId: project.projectId, hackathonId: project.hackathonId, projectUrl: project.projectUrl },
      input.fetcher ?? fetch,
    );
    if (outcome.ok) summary.refreshed += 1;
    else summary.failed += 1;
  }
  return summary;
}

/**
 * Opens one reconciliation per accountable imported project of every
 * submission period that has closed and has none yet. Idempotent, and a
 * catch-up rather than a step of the closure.
 *
 * It reads the CLOSED PERIOD'S OWN OUTCOMES rather than a status computed
 * now, which is what makes it a catch-up: the rows are there whoever closed
 * the period and whenever, so a pass that died between closing a week and
 * opening its reconciliations is repaired by the next one instead of leaving
 * a closed final period with nothing tracking its unverified submissions
 * forever.
 *
 * Only imported projects. A project an admin created in the CRM has no
 * Colosseum source at all, so there is no evidence that could ever arrive for
 * it and a pending row would be a question nobody can answer. Only
 * accountable ones, for the same reason a paused project has no missed week:
 * the reconciliation exists to correct a recorded outcome, and an exempt
 * project has none to correct.
 */
export async function openSubmissionReconciliations(
  db: BuilderDatabase | BuilderQuery,
  input: { hackathonId?: number } = {},
): Promise<number> {
  const values: unknown[] = [];
  let edition = "";
  if (input.hackathonId != null) {
    values.push(input.hackathonId);
    edition = ` AND p.hackathon_id = $${values.length}`;
  }
  const { rows } = await db.query(
    `INSERT INTO hq_submission_reconciliations (period_id, project_id, hackathon_id, deadline)
     SELECT o.period_id, o.project_id, p.hackathon_id, COALESCE(c.official_submission_deadline, p.ends_at - interval '1 millisecond')
     FROM hq_reporting_outcomes o
     JOIN hq_reporting_periods p ON p.id = o.period_id AND p.mode = 'submission' AND p.closed_at IS NOT NULL
     JOIN hq_project_onboarding b ON b.project_id = o.project_id
     LEFT JOIN hq_reporting_config c ON c.hackathon_id = p.hackathon_id
     WHERE o.exempt = false${edition}
     ON CONFLICT (period_id, project_id) DO NOTHING
     RETURNING project_id::text AS project_id`,
    values,
  );
  return rows.length;
}

export type ReconcileSummary = {
  attempted: number;
  resolved: number;
  stillPending: number;
  corrected: number;
  stoppedOnBudget: boolean;
};

/**
 * Attempts the pending reconciliations, oldest first, in a bounded batch.
 *
 * The honest cases, spelled out because getting any of them wrong would
 * manufacture history:
 *
 * - **The source cannot be reached.** `attempts` goes up, HQ's own error code
 *   is recorded, the row stays `pending` and NOTHING is written about the
 *   submission. An outage is not evidence of a failure to submit.
 * - **Colosseum answers, on time.** The evidence is recorded with the
 *   deadline it was judged against. If the closed week was recorded as
 *   missed, `correctOutcome` writes the correction beside the original with
 *   its reason and an audit event, and `outcome_corrected` stops a re-run
 *   doing it twice. The discovery being late changes nothing: the submitted
 *   timestamp and the deadline are what decide it.
 * - **Colosseum answers, after the deadline.** The evidence is recorded,
 *   `on_time` is false, and the missed week stands. A late submission does
 *   not erase an on-time failure.
 * - **Colosseum answers, nothing submitted.** Recorded, resolved, nothing
 *   corrected. The week already says what it says.
 */
export async function reconcileSubmissions(
  db: BuilderDatabase,
  input: { hackathonId?: number; atMs?: number; limit?: number; fetcher?: ColosseumFetch; deadlineMs?: number } = {},
): Promise<ReconcileSummary> {
  const atMs = input.atMs ?? Date.now();
  const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? RECONCILE_BATCH)));
  const values: unknown[] = [limit];
  let edition = "";
  if (input.hackathonId != null) {
    values.push(input.hackathonId);
    edition = ` AND r.hackathon_id = $${values.length}`;
  }
  const { rows: pending } = await db.query(
    `SELECT r.period_id::text AS period_id, r.project_id::text AS project_id, r.hackathon_id,
            o.project_url, p.ends_at, r.deadline
     FROM hq_submission_reconciliations r
     JOIN hq_project_onboarding o ON o.project_id = r.project_id
     JOIN hq_reporting_periods p ON p.id = r.period_id
     WHERE r.state = 'pending'${edition}
     ORDER BY r.updated_at ASC, r.project_id
     LIMIT $1`,
    values,
  );

  const summary: ReconcileSummary = { attempted: 0, resolved: 0, stillPending: 0, corrected: 0, stoppedOnBudget: false };
  if (!pending.length) return summary;

  // One configuration read per edition, not one per project: the deadline is
  // the edition's, and it must be the same number for every project in it.
  const deadlines = new Map<number, string | null>();
  for (const hackathonId of new Set(pending.filter((row) => row.deadline == null).map((row) => Number(row.hackathon_id)))) {
    deadlines.set(hackathonId, (await readReportingConfig(db, hackathonId)).officialSubmissionDeadline);
  }

  const actor: Actor = { kind: "job", audience: HQ_JOBS_AUDIENCE };
  const deadlineMs = Math.min(input.deadlineMs ?? Infinity, Date.now() + SOURCE_BUDGET_MS);
  for (const row of pending) {
    if (Date.now() + SOURCE_ATTEMPT_BUDGET_MS > deadlineMs) {
      summary.stoppedOnBudget = true;
      break;
    }
    summary.attempted += 1;
    const projectId = String(row.project_id);
    const periodId = String(row.period_id);
    const hackathonId = Number(row.hackathon_id);
    const deadline = row.deadline == null
      ? deadlines.get(hackathonId) ?? new Date(Date.parse(toIso(row.ends_at)) - 1).toISOString()
      : toIso(row.deadline);

    const outcome = await refreshColosseumTeam(
      { projectId, hackathonId, projectUrl: String(row.project_url) },
      input.fetcher ?? fetch,
    );
    if (!outcome.ok) {
      summary.stillPending += 1;
      await db.query(
        `UPDATE hq_submission_reconciliations SET attempts = attempts + 1, last_error = $3, updated_at = now()
         WHERE period_id = $1::uuid AND project_id = $2::uuid AND state = 'pending'`,
        [periodId, projectId, outcome.reason],
      );
      continue;
    }

    // Read the snapshot back rather than trusting the refresh's return value:
    // `interpretSubmission` wrote the status, and the timestamp beside it is
    // what the on-time comparison needs.
    const snapshot = (await readSubmissionSnapshots(db, [projectId])).get(projectId);
    const status: SubmissionStatus = snapshot?.submissionStatus ?? "not_checked";
    const submittedAt = snapshot?.submittedAt ?? null;
    if (status === "not_checked" || (status === "submitted" && !submittedAt)) {
      summary.stillPending += 1;
      await db.query(
        `UPDATE hq_submission_reconciliations SET attempts = attempts + 1, last_error = 'submission_unknown', updated_at = now()
         WHERE period_id = $1::uuid AND project_id = $2::uuid AND state = 'pending'`,
        [periodId, projectId],
      );
      continue;
    }
    const onTime = status === "submitted" ? submittedOnTime(submittedAt, deadline) : null;

    const corrected = status === "submitted" && onTime === true
      ? await correctOnTimeSubmission(db, { actor, periodId, projectId, submittedAt })
      : false;
    if (corrected) summary.corrected += 1;

    await db.query(
      `UPDATE hq_submission_reconciliations
       SET state = 'resolved', submission_status = $3, submitted_at = $4::timestamptz, deadline = $5::timestamptz,
           on_time = $6, evidence_at = $7::timestamptz, attempts = attempts + 1, last_error = NULL,
           outcome_corrected = outcome_corrected OR $8, updated_at = now()
       WHERE period_id = $1::uuid AND project_id = $2::uuid`,
      [periodId, projectId, status, submittedAt, deadline, onTime, new Date(atMs).toISOString(), corrected],
    );
    summary.resolved += 1;

  }
  return summary;
}

/**
 * Corrects a closed week that recorded a miss, when the evidence says the
 * team submitted on time after all.
 *
 * `correctOutcome` refuses an outcome that already reads the way it is being
 * asked for (`unchanged`), which is exactly what should happen for a week the
 * closure already completed, so there is no separate check here for it. A
 * week with no recorded outcome at all (`not_found`) is also not an error:
 * the project was not accountable for it.
 */
async function correctOnTimeSubmission(
  db: BuilderDatabase,
  input: { actor: Actor; periodId: string; projectId: string; submittedAt: string | null },
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT exempt, COALESCE(corrected_completed, completed) AS effective
     FROM hq_submission_reconciliations r
     JOIN hq_reporting_outcomes o ON o.period_id = r.period_id AND o.project_id = r.project_id
     WHERE r.period_id = $1::uuid AND r.project_id = $2::uuid`,
    [input.periodId, input.projectId],
  );
  if (!rows.length || Boolean(rows[0].exempt) || Boolean(rows[0].effective)) return false;
  const result = await correctOutcome(
    input.actor,
    {
      periodId: input.periodId,
      projectId: input.projectId,
      completed: true,
      reason: CORRECTION_REASON(input.submittedAt ?? "an unrecorded time"),
      operatorId: null,
    },
    db,
  );
  return result.ok;
}
