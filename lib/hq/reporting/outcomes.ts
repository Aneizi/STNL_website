import "server-only";
import type { Actor } from "../actor";
import { recordAuditEvent } from "../audit";
import { atomically, builderDatabase, type BuilderDatabase, type BuilderQuery } from "../builder-db";
import { HQ_JOBS_AUDIENCE } from "../github-actions-auth";
import { listReportingEligibility, PERIOD_COLUMNS, toIso, toPeriod } from "../reporting-enrolment";
import { accountable, auditActor, isUuidArg, toBasis } from "./shared";
import { reportingStatus } from "./status";

export type PeriodOutcome = {
  periodId: string;
  projectId: string;
  /** The factual on-time outcome recorded at close. Never rewritten. */
  completed: boolean;
  basis: "entry" | "submission" | "none";
  /** The project was paused when this period closed, so the period was excused rather than missed. */
  exempt: boolean;
  entryId: string | null;
  /**
   * The Captain responsible when the week ENDED, null when the project ended
   * the week unassigned. History: neither a later reassignment nor a late
   * closure changes it, which is why it is resolved from the assignment
   * history at the period's boundary rather than from whoever holds the
   * project when the closing job happens to run.
   */
  captainUserId: string | null;
  closedAt: string;
  /** An admin's later correction of a mistaken outcome, or null. The effective answer is this when set, `completed` otherwise. */
  correctedCompleted: boolean | null;
  correctionReason: string | null;
};

const toOutcome = (row: Record<string, unknown>): PeriodOutcome => ({
  periodId: String(row.period_id), projectId: String(row.project_id),
  completed: Boolean(row.completed), basis: toBasis(row.basis), exempt: Boolean(row.exempt),
  entryId: row.entry_id == null ? null : String(row.entry_id),
  captainUserId: row.captain_user_id == null ? null : String(row.captain_user_id),
  closedAt: toIso(row.closed_at),
  correctedCompleted: row.corrected_completed == null ? null : Boolean(row.corrected_completed),
  correctionReason: row.correction_reason == null ? null : String(row.correction_reason),
});

const OUTCOME_COLUMNS =
  "period_id::text AS period_id, project_id::text AS project_id, completed, basis, exempt, entry_id::text AS entry_id, captain_user_id, closed_at, corrected_completed, correction_reason";

export async function listPeriodOutcomes(db: BuilderQuery, periodId: string): Promise<PeriodOutcome[]> {
  const { rows } = await db.query(`SELECT ${OUTCOME_COLUMNS} FROM hq_reporting_outcomes WHERE period_id = $1::uuid ORDER BY project_id`, [periodId]);
  return rows.map(toOutcome);
}

export type ClosePeriodResult =
  | { ok: true; alreadyClosed: boolean; outcomes: PeriodOutcome[]; completed: number; missed: number }
  | { ok: false; reason: "not_found" | "not_ended" | "not_authorized" };

/**
 * Idempotent closure records the on-time outcome and the Captain responsible at
 * the period's end. Late entries and later assignments cannot rewrite history.
 * Corrections are stored alongside the original outcome, never over it.
 */
export async function closePeriod(
  db: BuilderDatabase | BuilderQuery,
  input: { periodId: string; actor: Actor; atMs?: number },
): Promise<ClosePeriodResult> {
  if (input.actor.kind === "member" || (input.actor.kind === "job" && input.actor.audience !== HQ_JOBS_AUDIENCE)) {
    return { ok: false, reason: "not_authorized" };
  }
  const atMs = input.atMs ?? Date.now();
  if (!isUuidArg(input.periodId)) return { ok: false, reason: "not_found" };
  return atomically(db, async (tx) => {
    const { rows } = await tx.query(`SELECT ${PERIOD_COLUMNS} FROM hq_reporting_periods WHERE id = $1::uuid FOR UPDATE`, [input.periodId]);
    if (!rows.length) return { ok: false, reason: "not_found" };
    const period = toPeriod(rows[0]);
    if (atMs < Date.parse(period.endsAt)) return { ok: false, reason: "not_ended" };
    if (period.closedAt) {
      const stored = await listPeriodOutcomes(tx, period.id);
      return {
        ok: true, alreadyClosed: true, outcomes: stored,
        completed: stored.filter((outcome) => outcome.completed && !outcome.exempt).length,
        missed: stored.filter((outcome) => !outcome.completed && !outcome.exempt).length,
      };
    }

    const statuses = await reportingStatus(tx, { hackathonId: period.hackathonId, atMs, includeHistory: true });
    const eligibility = new Map((await listReportingEligibility(tx, period.hackathonId)).map((row) => [row.projectId, row]));
    const { rows: firstEntries } = await tx.query(
      `SELECT DISTINCT ON (project_id) project_id::text AS project_id, id::text AS id FROM hq_reporting_entries
       WHERE period_id = $1::uuid AND voided_at IS NULL AND late = false AND counts_toward_completion
         AND submitted_at >= $2::timestamptz AND submitted_at < $3::timestamptz ORDER BY project_id, submitted_at, id`,
      [period.id, period.startsAt, period.endsAt],
    );
    const entryByProject = new Map(firstEntries.map((row) => [String(row.project_id), String(row.id)]));

    // Resolve responsibility at the exclusive period end, independent of when
    // this job runs: assigned before the boundary and not unassigned before it.
    const { rows: responsible } = await tx.query(
      `SELECT DISTINCT ON (a.project_id) a.project_id::text AS project_id, a.captain_user_id
       FROM hq_captain_assignments a
       JOIN hq_projects p ON p.id = a.project_id AND p.hackathon_id = $2
       WHERE a.captain_user_id IS NOT NULL
         AND a.assigned_at < $1::timestamptz
         AND (a.unassigned_at IS NULL OR a.unassigned_at >= $1::timestamptz)
       ORDER BY a.project_id, a.assigned_at DESC`,
      [period.endsAt, period.hackathonId],
    );
    const captainAtEnd = new Map(responsible.map((row) => [String(row.project_id), String(row.captain_user_id)]));

    for (const status of statuses) {
      const row = eligibility.get(status.projectId);
      // Omit projects that joined after the boundary. Persist paused projects
      // as exempt so resuming cannot turn a closed, excused week into a miss.
      if (!row || Date.parse(row.eligibleFrom) >= Date.parse(period.endsAt)) continue;
      const state = status.history.find((candidate) => candidate.periodId === period.id);
      if (!state) continue;
      const exempt = !accountable(row, period);
      await tx.query(
        `INSERT INTO hq_reporting_outcomes (period_id, project_id, completed, basis, exempt, entry_id, captain_user_id)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7) ON CONFLICT (period_id, project_id) DO NOTHING`,
        [period.id, status.projectId, state.completed, state.basis, exempt, entryByProject.get(status.projectId) ?? null, captainAtEnd.get(status.projectId) ?? null],
      );
    }
    await tx.query("UPDATE hq_reporting_periods SET closed_at = now() WHERE id = $1::uuid AND closed_at IS NULL", [period.id]);
    const outcomes = await listPeriodOutcomes(tx, period.id);
    const completed = outcomes.filter((outcome) => outcome.completed && !outcome.exempt).length;
    // An excused week is neither completed nor missed: counting it as missed
    // here would put a paused team into the very number the pause exists to
    // keep them out of.
    const missed = outcomes.filter((outcome) => !outcome.completed && !outcome.exempt).length;
    const exempt = outcomes.filter((outcome) => outcome.exempt).length;
    await recordAuditEvent(tx, {
      kind: "reporting.period_closed",
      actor: auditActor(input.actor),
      hackathonId: period.hackathonId,
      metadata: { periodId: period.id, sequence: period.sequence, mode: period.mode, projects: outcomes.length, completed, missed, exempt },
    });
    return { ok: true, alreadyClosed: false, outcomes, completed, missed };
  });
}

export type CorrectOutcomeResult =
  | { ok: true; outcome: PeriodOutcome }
  | { ok: false; reason: "not_found" | "not_authorized" | "reason_required" | "unchanged" };

/**
 * Operators and the HQ reconciliation job may correct an outcome with a reason.
 * Preserve the original completed value and audit the actual actor.
 */
export async function correctOutcome(
  actor: Actor,
  input: { periodId: string; projectId: string; completed: boolean; reason: string; operatorId?: string | null },
  db: BuilderDatabase | BuilderQuery = builderDatabase(),
): Promise<CorrectOutcomeResult> {
  if (actor.kind === "member" || (actor.kind === "job" && actor.audience !== HQ_JOBS_AUDIENCE)) return { ok: false, reason: "not_authorized" };
  if (!isUuidArg(input.projectId) || !isUuidArg(input.periodId)) return { ok: false, reason: "not_found" };
  const reason = String(input.reason ?? "").trim();
  if (!reason) return { ok: false, reason: "reason_required" };
  return atomically(db, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE hq_reporting_outcomes SET corrected_completed = $3, corrected_at = now(), corrected_by_user_id = $4::uuid, correction_reason = $5
       WHERE period_id = $1::uuid AND project_id = $2::uuid AND COALESCE(corrected_completed, completed) <> $3
       RETURNING ${OUTCOME_COLUMNS}`,
      [input.periodId, input.projectId, input.completed, actor.kind === "operator" ? actor.id : null, reason],
    );
    if (!rows.length) {
      const { rows: existing } = await tx.query(
        "SELECT 1 FROM hq_reporting_outcomes WHERE period_id = $1::uuid AND project_id = $2::uuid", [input.periodId, input.projectId],
      );
      return { ok: false, reason: existing.length ? "unchanged" : "not_found" };
    }
    const outcome = toOutcome(rows[0]);
    const { rows: edition } = await tx.query("SELECT hackathon_id FROM hq_projects WHERE id = $1::uuid", [input.projectId]);
    await recordAuditEvent(tx, {
      kind: "reporting.outcome_corrected",
      actor: auditActor(actor),
      hackathonId: edition.length ? Number(edition[0].hackathon_id) : null,
      projectId: input.projectId,
      metadata: { periodId: input.periodId, originalCompleted: outcome.completed, correctedCompleted: input.completed, reason },
    });
    return { ok: true, outcome };
  });
}
