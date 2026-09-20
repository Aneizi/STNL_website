// The reporting period generator: local dates from the hackathon's own
// record turned into UTC instants, with exclusive ends, an explicit
// final-period start that merges the remaining weeks into one
// submission-focus window, and a nudge instant per period.
//
// The table in the plan's Phase 5 is the reference case and is asserted
// literally below, including the UTC instants a CEST offset produces.
import { describe, expect, it } from "vitest";

import {
  addDays,
  generateReportingPeriods,
  periodForInstant,
  zonedDateTimeToUtc,
  type ReportingSchedule,
} from "@/lib/hq/reporting-periods";

/** The agreed 2026 campaign: 14 September to 12 October, final window from 5 October, Wednesday 12:00 nudges. */
const CAMPAIGN: ReportingSchedule = {
  startDate: "2026-09-14",
  endDate: "2026-10-12",
  timezone: "Europe/Amsterdam",
  finalPeriodStartDate: "2026-10-05",
  nudgeWeekday: 3,
  nudgeTime: "12:00",
};

describe("zonedDateTimeToUtc", () => {
  it("resolves a summer-time local midnight in Amsterdam to 22:00 the previous day in UTC", () => {
    expect(zonedDateTimeToUtc("2026-09-14", "00:00", "Europe/Amsterdam").toISOString()).toBe("2026-09-13T22:00:00.000Z");
  });

  it("resolves a winter-time local midnight in Amsterdam to 23:00 the previous day in UTC", () => {
    expect(zonedDateTimeToUtc("2026-11-02", "00:00", "Europe/Amsterdam").toISOString()).toBe("2026-11-01T23:00:00.000Z");
  });

  it("resolves a local midday across the autumn clock change without drifting", () => {
    expect(zonedDateTimeToUtc("2026-10-24", "12:00", "Europe/Amsterdam").toISOString()).toBe("2026-10-24T10:00:00.000Z");
    expect(zonedDateTimeToUtc("2026-10-26", "12:00", "Europe/Amsterdam").toISOString()).toBe("2026-10-26T11:00:00.000Z");
  });

  it("treats UTC as its own zone", () => {
    expect(zonedDateTimeToUtc("2026-09-14", "00:00", "UTC").toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });
});

describe("addDays", () => {
  it("counts calendar days, crossing a month end", () => {
    expect(addDays("2026-09-28", 7)).toBe("2026-10-05");
  });

  it("counts calendar days across a clock change, which is a date question and not a duration one", () => {
    expect(addDays("2026-10-24", 3)).toBe("2026-10-27");
  });
});

describe("generateReportingPeriods", () => {
  const periods = generateReportingPeriods(CAMPAIGN);

  it("produces exactly the four periods the plan's table names", () => {
    expect(periods.map((period) => [period.sequence, period.mode, period.startDate, period.endDate])).toEqual([
      [1, "weekly", "2026-09-14", "2026-09-20"],
      [2, "weekly", "2026-09-21", "2026-09-27"],
      [3, "weekly", "2026-09-28", "2026-10-04"],
      [4, "submission", "2026-10-05", "2026-10-12"],
    ]);
  });

  it("stores UTC instants with an exclusive end, so no fifth period begins on 12 October", () => {
    expect(periods[0].startsAt).toBe("2026-09-13T22:00:00.000Z");
    expect(periods[0].endsAt).toBe("2026-09-20T22:00:00.000Z");
    expect(periods[3].startsAt).toBe("2026-10-04T22:00:00.000Z");
    expect(periods[3].endsAt).toBe("2026-10-12T22:00:00.000Z");
  });

  it("leaves no gap and no overlap between consecutive periods", () => {
    for (let index = 1; index < periods.length; index += 1) {
      expect(periods[index].startsAt).toBe(periods[index - 1].endsAt);
    }
  });

  it("puts each nudge on the configured weekday at the configured local time", () => {
    expect(periods.map((period) => period.nudgeAt)).toEqual([
      "2026-09-16T10:00:00.000Z",
      "2026-09-23T10:00:00.000Z",
      "2026-09-30T10:00:00.000Z",
      "2026-10-07T10:00:00.000Z",
    ]);
  });

  it("generates only weekly periods when no final period is configured", () => {
    const weekly = generateReportingPeriods({ ...CAMPAIGN, finalPeriodStartDate: null });
    expect(weekly.map((period) => [period.mode, period.startDate, period.endDate])).toEqual([
      ["weekly", "2026-09-14", "2026-09-20"],
      ["weekly", "2026-09-21", "2026-09-27"],
      ["weekly", "2026-09-28", "2026-10-04"],
      ["weekly", "2026-10-05", "2026-10-11"],
      ["weekly", "2026-10-12", "2026-10-12"],
    ]);
  });

  it("truncates the weekly period that a mid-week final start interrupts", () => {
    const merged = generateReportingPeriods({ ...CAMPAIGN, finalPeriodStartDate: "2026-10-01" });
    expect(merged.map((period) => [period.mode, period.startDate, period.endDate])).toEqual([
      ["weekly", "2026-09-14", "2026-09-20"],
      ["weekly", "2026-09-21", "2026-09-27"],
      ["weekly", "2026-09-28", "2026-09-30"],
      ["submission", "2026-10-01", "2026-10-12"],
    ]);
  });

  it("ignores a final start outside the campaign and keeps a weekly schedule", () => {
    expect(generateReportingPeriods({ ...CAMPAIGN, finalPeriodStartDate: "2026-11-01" }).every((p) => p.mode === "weekly")).toBe(true);
    expect(generateReportingPeriods({ ...CAMPAIGN, finalPeriodStartDate: "2026-08-01" }).every((p) => p.mode === "weekly")).toBe(true);
  });

  it("makes the whole campaign one submission period when the final start is its first day", () => {
    expect(generateReportingPeriods({ ...CAMPAIGN, finalPeriodStartDate: "2026-09-14" })).toEqual([
      expect.objectContaining({ sequence: 1, mode: "submission", startDate: "2026-09-14", endDate: "2026-10-12" }),
    ]);
  });

  it("drops a nudge that would fall outside its own period", () => {
    // A three-day opening week ending on Tuesday: Wednesday is the next
    // period's business, not a nudge nobody could act on.
    const shortFirst = generateReportingPeriods({ ...CAMPAIGN, startDate: "2026-09-14", finalPeriodStartDate: "2026-09-16" });
    expect(shortFirst[0].nudgeAt).toBe(null);
    expect(shortFirst[1].nudgeAt).toBe("2026-09-16T10:00:00.000Z");
  });

  it("keeps local midnight boundaries across an autumn clock change", () => {
    const autumn = generateReportingPeriods({
      ...CAMPAIGN, startDate: "2026-10-19", endDate: "2026-11-01", finalPeriodStartDate: null,
    });
    expect(autumn.map((period) => [period.startsAt, period.endsAt])).toEqual([
      ["2026-10-18T22:00:00.000Z", "2026-10-25T23:00:00.000Z"],
      ["2026-10-25T23:00:00.000Z", "2026-11-01T23:00:00.000Z"],
    ]);
  });

  it("returns nothing for an empty or inverted campaign window", () => {
    expect(generateReportingPeriods({ ...CAMPAIGN, startDate: "2026-10-12", endDate: "2026-09-14" })).toEqual([]);
  });

  it("produces a single one-day period for a one-day campaign", () => {
    const oneDay = generateReportingPeriods({ ...CAMPAIGN, startDate: "2026-09-14", endDate: "2026-09-14", finalPeriodStartDate: null });
    expect(oneDay).toEqual([
      expect.objectContaining({ sequence: 1, startDate: "2026-09-14", endDate: "2026-09-14", endsAt: "2026-09-14T22:00:00.000Z" }),
    ]);
  });
});

describe("periodForInstant", () => {
  const periods = generateReportingPeriods(CAMPAIGN);

  it("picks the period containing the instant, with an inclusive start", () => {
    expect(periodForInstant(periods, Date.parse("2026-09-13T22:00:00.000Z"))?.sequence).toBe(1);
    expect(periodForInstant(periods, Date.parse("2026-09-20T21:59:59.999Z"))?.sequence).toBe(1);
  });

  it("treats the end as exclusive, so a boundary instant belongs to the next period", () => {
    expect(periodForInstant(periods, Date.parse("2026-09-20T22:00:00.000Z"))?.sequence).toBe(2);
  });

  it("returns null before the first period and after the last", () => {
    expect(periodForInstant(periods, Date.parse("2026-09-13T21:59:59.999Z"))).toBe(null);
    expect(periodForInstant(periods, Date.parse("2026-10-12T22:00:00.000Z"))).toBe(null);
  });
});
