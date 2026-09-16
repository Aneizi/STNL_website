import type { MemberWeekSummary } from "./reporting-surface";

export type DashboardSubmissionAttention = NonNullable<MemberWeekSummary["submission"]>;

/** A Home indicator means there is a current requirement the member can complete. */
export function projectNeedsAttention(
  summary: MemberWeekSummary | null | undefined,
  nowMs: number,
): boolean {
  if (!summary?.enrolled || summary.paused || !summary.current || !Number.isFinite(nowMs)) return false;
  const current = summary.current;
  if (!(Date.parse(current.startsAt) <= nowMs && nowMs < Date.parse(current.endsAt))) return false;
  if (!current.completed) return true;

  // A written update can complete the final period while the submission is
  // still outstanding. An unknown status offers a status check; a confirmed
  // missing submission offers submission only while its deadline is open.
  const submission = summary.submission;
  if (!submission?.open || submission.periodId !== current.periodId) return false;
  if (submission.submissionStatus === "not_checked") return true;
  return submission.submissionStatus === "not_submitted" && nowMs < Date.parse(submission.deadline);
}

// Missed weeks alone never trigger attention: a late update is allowed, but
// it cannot complete or erase a recorded missed week.
