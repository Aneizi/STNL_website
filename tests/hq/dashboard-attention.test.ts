import { describe, expect, it } from "vitest";
import { projectNeedsAttention, type DashboardSubmissionAttention } from "@/lib/hq/dashboard-attention";
import type { MemberWeekSummary } from "@/lib/hq/reporting-surface";

const current: NonNullable<MemberWeekSummary["current"]> = {
  periodId: "week-1", periodSequence: 1, startDate: "2026-09-14", endDate: "2026-09-20",
  startsAt: "2026-09-13T22:00:00Z", endsAt: "2026-09-20T22:00:00Z", completed: false,
};
const summary: MemberWeekSummary = {
  projectId: "team", projectName: "Team", hackathonId: 1, timezone: "Europe/Amsterdam",
  enrolled: true, paused: false, current, missedPeriods: 0, totalPeriods: 4,
};
const during = Date.parse("2026-09-16T10:00:00Z");
const complete = { ...summary, current: { ...current, completed: true } };
const submission: DashboardSubmissionAttention = {
  periodId: "week-1", open: true,
  submissionStatus: "not_submitted", deadline: "2026-09-18T12:00:00Z",
};

describe("Home project attention", () => {
  it("indicates an incomplete open period on any day, including outside the weekly reminder days", () => {
    for (const at of ["2026-09-14T10:00:00Z", "2026-09-16T10:00:00Z", "2026-09-20T10:00:00Z"]) {
      expect(projectNeedsAttention(summary, Date.parse(at))).toBe(true);
    }
  });

  it("uses the period's exact start and exclusive end boundaries", () => {
    expect(projectNeedsAttention(summary, Date.parse(current.startsAt) - 1)).toBe(false);
    expect(projectNeedsAttention(summary, Date.parse(current.startsAt))).toBe(true);
    expect(projectNeedsAttention(summary, Date.parse(current.endsAt) - 1)).toBe(true);
    expect(projectNeedsAttention(summary, Date.parse(current.endsAt))).toBe(false);
  });

  it("does not indicate completed, paused, unenrolled, missing, or inactive reporting", () => {
    for (const state of [complete, { ...summary, paused: true }, { ...summary, enrolled: false }, { ...summary, current: null }, null, undefined]) {
      expect(projectNeedsAttention(state, during)).toBe(false);
    }
  });

  it("does not turn historical missed weeks into a task the member cannot clear", () => {
    expect(projectNeedsAttention({ ...complete, missedPeriods: 3 }, during)).toBe(false);
    expect(projectNeedsAttention({ ...summary, current: null, missedPeriods: 3 }, during)).toBe(false);
    expect(projectNeedsAttention({ ...summary, missedPeriods: 3 }, Date.parse(current.endsAt))).toBe(false);
  });

  it("does not show a deadline indicator for invalid timing data", () => {
    expect(projectNeedsAttention(summary, Number.NaN)).toBe(false);
    expect(projectNeedsAttention({ ...summary, current: { ...current, endsAt: "invalid" } }, during)).toBe(false);
  });

  it("keeps attention on an outstanding submission after a written update completes the period", () => {
    expect(projectNeedsAttention({ ...complete, submission }, during)).toBe(true);
    expect(projectNeedsAttention({ ...complete, submission: { ...submission, submissionStatus: "submitted" } }, during)).toBe(false);
  });

  it("stops submission attention at its deadline even while the reporting period remains open", () => {
    const deadline = Date.parse(submission.deadline);
    expect(projectNeedsAttention({ ...complete, submission }, deadline - 1)).toBe(true);
    expect(projectNeedsAttention({ ...complete, submission }, deadline)).toBe(false);
    // The reporting update remains independently actionable until its own end.
    expect(projectNeedsAttention({ ...summary, submission }, deadline)).toBe(true);
  });

  it("indicates an available status check for an unknown submission while the final period is open", () => {
    const unknown: MemberWeekSummary = { ...complete, submission: { ...submission, submissionStatus: "not_checked" } };
    expect(projectNeedsAttention(unknown, during)).toBe(true);
    expect(projectNeedsAttention(unknown, Date.parse(submission.deadline))).toBe(true);
    expect(projectNeedsAttention(unknown, Date.parse(current.endsAt))).toBe(false);
  });

  it("does not indicate unavailable submission actions or a different period's submission", () => {
    for (const state of [
      { ...submission, open: false },
      { ...submission, periodId: "other-period" },
      { ...submission, deadline: "invalid" },
    ]) expect(projectNeedsAttention({ ...complete, submission: state }, during)).toBe(false);
    expect(projectNeedsAttention({ ...complete, paused: true, submission }, during)).toBe(false);
    expect(projectNeedsAttention({ ...complete, enrolled: false, submission }, during)).toBe(false);
    expect(projectNeedsAttention({ ...complete, current: null, submission }, during)).toBe(false);
  });
});
