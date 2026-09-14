// The reporting screens' presentation rules, which are pure and therefore
// assertable without a database or a render: the week's wording, the deadline,
// the Monday and Tuesday prompt rule, the refusal messages, and the ordering
// that puts the outstanding work first.
//
// The copy scan at the end is the plan's phase 6 acceptance bullet
// ("Interface copy contains no em dashes or middots") held to the module that
// owns the copy, rather than to one rendered page.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ADD_UPDATE_MESSAGES,
  AUDIENCE_NOTES,
  byOutstandingFirst,
  deadlineLabel,
  EDIT_UPDATE_MESSAGES,
  MAX_CONTACT_LENGTH,
  missedLabel,
  NO_UPDATES_YET,
  normalizeContact,
  periodRangeLabel,
  promptDismissKey,
  REPORTING_STATUS_LABELS,
  shouldPromptUpdate,
  statusLabel,
  SUBMISSION_FILTER_LABEL,
  weekdayInZone,
  weekdayName,
} from "@/lib/hq/reporting-view";

const AMSTERDAM = "Europe/Amsterdam";

/** The plan's first week: 14 to 21 September 2026, in Europe/Amsterdam. */
const WEEK_ONE = {
  completed: false,
  startsAt: "2026-09-13T22:00:00.000Z",
  endsAt: "2026-09-20T22:00:00.000Z",
};

describe("the week as a screen says it", () => {
  it("prints the inclusive local dates, never the exclusive end instant", () => {
    expect(periodRangeLabel("2026-09-14", "2026-09-20")).toBe("14 to 20 September");
    expect(periodRangeLabel("2026-09-28", "2026-10-04")).toBe("28 September to 4 October");
    expect(periodRangeLabel("2026-10-05", "2026-10-05")).toBe("5 October");
    expect(periodRangeLabel("", "2026-10-05")).toBe("");
  });

  it("names the deadline as the day it falls on", () => {
    expect(weekdayName("2026-09-20")).toBe("Sunday");
    expect(deadlineLabel("2026-09-20")).toBe("Sunday 20 September");
    expect(deadlineLabel("")).toBe("");
  });

  it("has exactly two words for a week's state, and no third", () => {
    expect(statusLabel(true)).toBe(REPORTING_STATUS_LABELS.updated);
    expect(statusLabel(false)).toBe(REPORTING_STATUS_LABELS.missed);
    expect(new Set(Object.values(REPORTING_STATUS_LABELS)).size).toBe(2);
  });

  it("counts missed weeks in words, and says nothing when none are", () => {
    expect(missedLabel(0)).toBe("");
    expect(missedLabel(1)).toBe("1 week missed");
    expect(missedLabel(3)).toBe("3 weeks missed");
  });

  it("keeps the Colosseum filter's wording distinct from the weekly one", () => {
    expect(SUBMISSION_FILTER_LABEL).not.toBe(REPORTING_STATUS_LABELS.missed);
  });
});

describe("the Monday and Tuesday prompt", () => {
  // 14 September 2026 is a Monday in Amsterdam; 12:00 local is 10:00 UTC.
  const monday = Date.parse("2026-09-14T10:00:00.000Z");
  const tuesday = Date.parse("2026-09-15T10:00:00.000Z");
  const wednesday = Date.parse("2026-09-16T10:00:00.000Z");
  const sunday = Date.parse("2026-09-20T10:00:00.000Z");

  it("reads the weekday in the campaign timezone, not the server's", () => {
    // 23:30 UTC on Sunday is already Monday in Amsterdam.
    expect(weekdayInZone(Date.parse("2026-09-13T23:30:00.000Z"), AMSTERDAM)).toBe(1);
    expect(weekdayInZone(Date.parse("2026-09-13T23:30:00.000Z"), "UTC")).toBe(7);
  });

  it("prompts on Monday and Tuesday while the week is outstanding", () => {
    for (const atMs of [monday, tuesday]) {
      expect(shouldPromptUpdate({ current: WEEK_ONE, atMs, timezone: AMSTERDAM, paused: false })).toBe(true);
    }
  });

  it("says nothing on the other days", () => {
    for (const atMs of [wednesday, sunday]) {
      expect(shouldPromptUpdate({ current: WEEK_ONE, atMs, timezone: AMSTERDAM, paused: false })).toBe(false);
    }
  });

  it("stops for good once the week is complete, whatever the day", () => {
    expect(shouldPromptUpdate({ current: { ...WEEK_ONE, completed: true }, atMs: monday, timezone: AMSTERDAM, paused: false })).toBe(false);
  });

  it("says nothing for a paused project, outside the campaign, or for an instant the week does not contain", () => {
    expect(shouldPromptUpdate({ current: WEEK_ONE, atMs: monday, timezone: AMSTERDAM, paused: true })).toBe(false);
    expect(shouldPromptUpdate({ current: null, atMs: monday, timezone: AMSTERDAM, paused: false })).toBe(false);
    // A Monday three weeks later: still a Monday, but not inside this week.
    expect(shouldPromptUpdate({ current: WEEK_ONE, atMs: Date.parse("2026-10-05T10:00:00.000Z"), timezone: AMSTERDAM, paused: false })).toBe(false);
  });

  it("keys a dismissal to one project and one week, so neither leaks into another", () => {
    expect(promptDismissKey("project-a", "week-1")).not.toBe(promptDismissKey("project-a", "week-2"));
    expect(promptDismissKey("project-a", "week-1")).not.toBe(promptDismissKey("project-b", "week-1"));
  });
});

describe("the refusal messages", () => {
  it("gives every create refusal its own wording, never a shared generic one", () => {
    const messages = Object.values(ADD_UPDATE_MESSAGES);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it("gives every edit refusal its own wording too", () => {
    const messages = Object.values(EDIT_UPDATE_MESSAGES);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it("tells the two data-carrying refusals that the text is not lost", () => {
    expect(ADD_UPDATE_MESSAGES.period_changed).toMatch(/still here/i);
    expect(EDIT_UPDATE_MESSAGES.conflict).toMatch(/kept below/i);
  });

  it("describes each audience before the save rather than after it", () => {
    expect(AUDIENCE_NOTES.shared).toMatch(/team/i);
    expect(AUDIENCE_NOTES.sensitive).toMatch(/admins/i);
    expect(AUDIENCE_NOTES.sensitive).toMatch(/completes the week/i);
  });
});

describe("the contact rule", () => {
  it("stores trimmed text, and nothing at all for an empty one", () => {
    expect(normalizeContact("  @handle  ")).toBe("@handle");
    expect(normalizeContact("   ")).toBeNull();
    expect(normalizeContact(null)).toBeNull();
    expect(normalizeContact(undefined)).toBeNull();
  });

  it("caps the length rather than refusing a long one", () => {
    expect(normalizeContact("x".repeat(500))).toHaveLength(MAX_CONTACT_LENGTH);
  });
});

describe("ordering a Captain's or an admin's list", () => {
  const card = (projectName: string, completed: boolean | null, missedPeriods = 0) => ({
    projectName,
    missedPeriods,
    current: completed === null ? null : { completed },
  });

  it("puts this week's outstanding work first, then the most missed, then a stable name order", () => {
    const rows = [
      card("Zeta", true),
      card("Alpha", true),
      card("Beta", false),
      card("Gamma", false, 2),
      card("Delta", null, 5),
    ];
    expect([...rows].sort(byOutstandingFirst).map((row) => row.projectName)).toEqual([
      "Gamma", "Beta", "Delta", "Alpha", "Zeta",
    ]);
  });
});

describe("the copy rule", () => {
  // The plan's phase 6 acceptance: no em dashes and no middots in interface
  // text. Every string this module exports is interface text, so they are
  // checked directly rather than through one rendered page.
  const copy = [
    ...Object.values(ADD_UPDATE_MESSAGES),
    ...Object.values(EDIT_UPDATE_MESSAGES),
    ...Object.values(AUDIENCE_NOTES),
    ...Object.values(REPORTING_STATUS_LABELS),
    NO_UPDATES_YET,
    SUBMISSION_FILTER_LABEL,
    missedLabel(2),
    periodRangeLabel("2026-09-14", "2026-10-04"),
    deadlineLabel("2026-09-20"),
  ];

  it("has no em dash and no middot anywhere in it", () => {
    for (const line of copy) expect(line, line).not.toMatch(/[—·]/);
  });

  it("leaves the reporting components free of them as well", () => {
    for (const file of [
      "components/hq/reporting-member.tsx",
      "components/hq/reporting-admin.tsx",
      "components/hq/reporting-project-panel.tsx",
    ]) {
      // Comments are prose for the next reader, not interface copy, so only
      // the quoted and JSX text is scanned.
      const source = readFileSync(join(process.cwd(), file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/[—·]/);
    }
  });
});
