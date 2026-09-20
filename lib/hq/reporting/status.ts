import "server-only";
import type { BuilderQuery } from "../builder-db";
import { submittedOnTime, type SubmissionStatus } from "../colosseum-snapshot";
import { listReportingEligibility, listReportingPeriods, toIso, type ReportingEligibility, type ReportingPeriod } from "../reporting-enrolment";
import type { ReportingPeriodMode } from "../reporting-periods";
import { accountable, toBasis } from "./shared";

/** One period's state for one project. `basis` says how a completed period was completed, mirroring the stored outcome's own column. */
export type PeriodStatus = {
  periodId: string;
  periodSequence: number;
  mode: ReportingPeriodMode;
  startDate: string;
  endDate: string;
  /** The inclusive start instant, so a screen can tell whether this week is open at the instant it is rendering for. */
  startsAt: string;
  /** The exclusive end, which is the deadline a screen counts down to. */
  endsAt: string;
  nudgeAt: string | null;
  completed: boolean;
  basis: "entry" | "submission" | "none";
  /** Qualifying entries: written by the team, neither voided nor late. A Captain's or an operator's note is not one. Never the bodies. */
  entries: number;
  latestEntryAt: string | null;
  closed: boolean;
  /**
   * The project was not being counted for this period: it was paused. Never
   * a missed week, whatever `completed` says. Recorded on the outcome at
   * close, and derived live from the pause history before then.
   */
  exempt: boolean;
};

/**
 * A project's reporting state, the shape every dashboard reads. It carries
 * `projectName` and `imported` from the project itself, so a Captain or admin
 * surface can render a project with no imported team behind it without a
 * second lookup and without a reduced row.
 */
export type ProjectReportingStatus = {
  projectId: string;
  projectName: string;
  hackathonId: number;
  imported: boolean;
  eligibleFrom: string;
  paused: boolean;
  /** The project's current Captain, or null. An id, for a caller that has already earned the right to it. */
  captainUserId: string | null;
  submissionStatus: SubmissionStatus;
  /** The period open at the instant asked about, or null outside the campaign. */
  current: PeriodStatus | null;
  /** Periods this project was accountable for and did not complete. */
  missedPeriods: number;
  history: PeriodStatus[];
};

/** Stored Colosseum submission signal; never re-derived from completeness. */
export type { SubmissionStatus } from "../colosseum-snapshot";

export type ReportingStatusInput = {
  hackathonId: number;
  /** Narrow to these projects; omit for every project in the edition's reporting. */
  projectIds?: readonly string[];
  atMs?: number;
  /** Include every period's state per project, not only the open one and the missed count. */
  includeHistory?: boolean;
};

type EntryTally = { entries: number; latestEntryAt: string | null };

/**
 * Only confirmed, on-time submissions satisfy the final period. The official
 * external deadline takes precedence; submissions before the period still count.
 */
function submissionSatisfies(
  period: ReportingPeriod,
  project: { submissionStatus: SubmissionStatus; submittedAt: string | null },
  officialDeadline: string | null,
): boolean {
  if (period.mode !== "submission" || project.submissionStatus !== "submitted") return false;
  return submittedOnTime(project.submittedAt, officialDeadline ?? period.endsAt, officialDeadline == null) === true;
}

/**
 * Fixed grouped reads for the edition, with no entry or revision bodies.
 * Stored outcomes and corrections take precedence. Until closure, derive the
 * same result that closePeriod will record, including historical exemptions.
 */
export async function reportingStatus(db: BuilderQuery, input: ReportingStatusInput): Promise<ProjectReportingStatus[]> {
  const atMs = input.atMs ?? Date.now();
  const filter = input.projectIds ? [...new Set(input.projectIds)] : null;
  if (filter && !filter.length) return [];

  const [periods, eligibility, config] = await Promise.all([
    listReportingPeriods(db, input.hackathonId),
    listReportingEligibility(db, input.hackathonId, filter ?? undefined),
    db.query("SELECT official_submission_deadline FROM hq_reporting_config WHERE hackathon_id = $1", [input.hackathonId]),
  ]);
  const officialDeadline = config.rows.length && config.rows[0].official_submission_deadline != null
    ? toIso(config.rows[0].official_submission_deadline) : null;
  const projects = eligibility;
  if (!projects.length || !periods.length) return projects.map((row) => bareStatus(row, "not_checked"));
  const projectIds = projects.map((row) => row.projectId);

  const [tallies, outcomes, submissions, assignments] = await Promise.all([
    db.query(
      `SELECT e.project_id::text AS project_id, e.period_id::text AS period_id, count(*)::int AS entries,
              max(e.submitted_at) AS latest
       FROM hq_reporting_entries e JOIN hq_reporting_periods p ON p.id = e.period_id
       WHERE p.hackathon_id = $1 AND e.project_id = ANY($2::uuid[]) AND e.voided_at IS NULL AND e.late = false
         AND e.counts_toward_completion
         AND e.submitted_at >= p.starts_at AND e.submitted_at < p.ends_at
       GROUP BY e.project_id, e.period_id`,
      [input.hackathonId, projectIds],
    ),
    db.query(
      `SELECT o.project_id::text AS project_id, o.period_id::text AS period_id, o.completed, o.corrected_completed, o.basis, o.exempt, o.entry_id::text AS entry_id
       FROM hq_reporting_outcomes o JOIN hq_reporting_periods p ON p.id = o.period_id
       WHERE p.hackathon_id = $1 AND o.project_id = ANY($2::uuid[])`,
      [input.hackathonId, projectIds],
    ),
    db.query(
      `SELECT project_id::text AS project_id, submission_status, submitted_at FROM hq_project_onboarding WHERE project_id = ANY($1::uuid[])`,
      [projectIds],
    ),
    db.query(
      `SELECT project_id::text AS project_id, captain_user_id FROM hq_captain_assignments
       WHERE project_id = ANY($1::uuid[]) AND unassigned_at IS NULL AND captain_user_id IS NOT NULL`,
      [projectIds],
    ),
  ]);

  const key = (projectId: string, periodId: string) => `${projectId}|${periodId}`;
  const tallyBy = new Map<string, EntryTally>(tallies.rows.map((row) => [
    key(String(row.project_id), String(row.period_id)),
    { entries: Number(row.entries), latestEntryAt: row.latest == null ? null : toIso(row.latest) },
  ]));
  const outcomeBy = new Map(outcomes.rows.map((row) => [key(String(row.project_id), String(row.period_id)), row]));
  const submissionBy = new Map(submissions.rows.map((row) => [
    String(row.project_id),
    { submissionStatus: (row.submission_status ?? "not_checked") as SubmissionStatus, submittedAt: row.submitted_at == null ? null : toIso(row.submitted_at) },
  ]));
  const captainBy = new Map(assignments.rows.map((row) => [String(row.project_id), String(row.captain_user_id)]));

  return projects.map((project) => {
    const submission = submissionBy.get(project.projectId) ?? { submissionStatus: "not_checked" as SubmissionStatus, submittedAt: null };
    const history: PeriodStatus[] = [];
    let missed = 0;
    let current: PeriodStatus | null = null;
    for (const period of periods) {
      const tally = tallyBy.get(key(project.projectId, period.id));
      const outcome = outcomeBy.get(key(project.projectId, period.id));
      const isAccountable = accountable(project, period);
      const live: PeriodStatus["basis"] = tally ? "entry" : submissionSatisfies(period, submission, officialDeadline) ? "submission" : "none";
      const recorded = outcome
        ? { completed: Boolean(outcome.corrected_completed ?? outcome.completed), basis: toBasis(outcome.basis), exempt: Boolean(outcome.exempt) }
        // Before closure the pause history answers it; afterwards the row
        // does, which is what stops a lifted pause from turning into missed
        // weeks.
        : { completed: live !== "none", basis: live, exempt: !isAccountable };
      const status: PeriodStatus = {
        periodId: period.id, periodSequence: period.sequence, mode: period.mode,
        startDate: period.startDate, endDate: period.endDate, startsAt: period.startsAt, endsAt: period.endsAt, nudgeAt: period.nudgeAt,
        completed: recorded.completed, basis: recorded.basis, exempt: recorded.exempt,
        entries: tally?.entries ?? 0, latestEntryAt: tally?.latestEntryAt ?? null,
        closed: period.closedAt != null,
      };
      history.push(status);
      if (Date.parse(period.startsAt) <= atMs && atMs < Date.parse(period.endsAt)) current = status;
      else if (Date.parse(period.endsAt) <= atMs && !status.exempt && !status.completed) missed += 1;
    }
    return {
      projectId: project.projectId, projectName: project.projectName, hackathonId: project.hackathonId,
      imported: project.imported, eligibleFrom: project.eligibleFrom, paused: project.paused,
      captainUserId: captainBy.get(project.projectId) ?? null,
      submissionStatus: submission.submissionStatus,
      current, missedPeriods: missed,
      history: input.includeHistory ? history : [],
    };
  });
}

/** A project in reporting for an edition whose schedule has no periods yet. */
const bareStatus = (project: ReportingEligibility, submissionStatus: SubmissionStatus): ProjectReportingStatus => ({
  projectId: project.projectId, projectName: project.projectName, hackathonId: project.hackathonId,
  imported: project.imported, eligibleFrom: project.eligibleFrom, paused: project.paused,
  captainUserId: null, submissionStatus, current: null, missedPeriods: 0, history: [],
});
