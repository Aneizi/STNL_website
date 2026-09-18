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
  captainMetaLabel,
  dayMonthLabel,
  deadlineLabel,
  dueLabel,
  dueLine,
  EARLIER_NOTE,
  EDIT_UPDATE_MESSAGES,
  entryMetaLabel,
  HEADING_DONE,
  HEADING_OPEN,
  isWeekCurrent,
  isWeekStarted,
  LATE_NOTE,
  MAX_CONTACT_LENGTH,
  missedLabel,
  mergeUpdatePages,
  NO_UPDATES_YET,
  normalizeContact,
  NOTE_ADDED,
  periodRangeLabel,
  periodRangeShortLabel,
  PRIVATE_TOOLTIP,
  promptDismissKey,
  REPORTING_STATUS_LABELS,
  SAVED_LABEL,
  shouldPromptUpdate,
  statusLabel,
  SUBMISSION_FILTER_LABEL,
  telegramContactHref,
  UPDATE_SAVED,
  UPDATED_LABEL,
  weekdayInZone,
  weekdayName,
  weekOfLabel,
} from "@/lib/hq/reporting-view";

const AMSTERDAM = "Europe/Amsterdam";

describe("updates after saves and page refreshes", () => {
  const old = { id: "old", version: 1, submittedAt: "2026-09-14T10:00:00Z", body: "Before" };
  const latest = { id: "new", version: 1, submittedAt: "2026-09-15T10:00:00Z", body: "Today" };
  it("shows a new first-page update while retaining already loaded older entries", () => {
    expect(mergeUpdatePages([old], [latest])).toEqual([latest, old]);
  });
  it("replaces a saved entry once, without losing older pages or reversing a newer edit", () => {
    const edited = { ...old, version: 2, body: "After" };
    expect(mergeUpdatePages([latest, old], [edited])).toEqual([latest, edited]);
    expect(mergeUpdatePages([latest, edited], [old, latest])).toEqual([latest, edited]);
  });
  it("uses a stable ID order when timestamps tie, matching the server cursor", () => {
    expect(mergeUpdatePages([old], [{ ...old, id: "z" }]).map((entry) => entry.id)).toEqual(["z", "old"]);
  });
});

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

describe("the redesigned member screens' words for a week", () => {
  it("counts the campaign as Week n of N", () => {
    expect(weekOfLabel(1, 4)).toBe("Week 1 of 4");
    expect(weekOfLabel(4, 4)).toBe("Week 4 of 4");
  });

  it("names the deadline as the last minute of the week in the campaign timezone, zone included", () => {
    // Week one ends at local midnight after Sunday 20 September; the last
    // minute that counts is 23:59 on the Sunday, and September is summer time.
    expect(dueLabel(WEEK_ONE.endsAt, AMSTERDAM)).toBe("Sunday 20 September, 23:59 CEST");
    expect(dueLine(WEEK_ONE.endsAt, AMSTERDAM)).toBe("Due Sunday 20 September, 23:59 CEST");
    // A winter week in the same zone reads CET; the same instant elsewhere reads that zone's own clock.
    expect(dueLabel("2026-11-08T23:00:00.000Z", AMSTERDAM)).toBe("Sunday 8 November, 23:59 CET");
    expect(dueLabel(WEEK_ONE.endsAt, "UTC")).toBe("Sunday 20 September, 21:59 UTC");
    expect(dueLabel("", AMSTERDAM)).toBe("");
    expect(dueLabel("not a date", AMSTERDAM)).toBe("");
  });

  it("shortens a week's range for the late-update buttons, naming the month once when it is shared", () => {
    expect(periodRangeShortLabel("2026-09-14", "2026-09-20")).toBe("14 to 20 Sep");
    expect(periodRangeShortLabel("2026-09-28", "2026-10-04")).toBe("28 Sep to 4 Oct");
    expect(periodRangeShortLabel("2026-10-05", "2026-10-12")).toBe("5 to 12 Oct");
    expect(periodRangeShortLabel("2026-10-05", "2026-10-05")).toBe("5 Oct");
    expect(periodRangeShortLabel("", "2026-10-05")).toBe("");
  });

  it("dates an entry by the campaign's day, not the browser's", () => {
    expect(dayMonthLabel("2026-09-16T10:00:00.000Z", AMSTERDAM)).toBe("16 September");
    // 23:30 UTC on the 15th is already the 16th in Amsterdam.
    expect(dayMonthLabel("2026-09-15T23:30:00.000Z", AMSTERDAM)).toBe("16 September");
    expect(dayMonthLabel("2026-09-15T23:30:00.000Z", "UTC")).toBe("15 September");
    expect(dayMonthLabel("", AMSTERDAM)).toBe("");
  });

  const written = { periodSequence: 1, authorName: "Nienke Visser", authorIsYou: false, late: false, edited: false, submittedAt: "2026-09-16T10:00:00.000Z" };

  it("words the team page's meta line with the week, the author and the day, and its two suffixes", () => {
    expect(entryMetaLabel(written, AMSTERDAM)).toBe("Week 1. Nienke Visser, 16 September");
    expect(entryMetaLabel({ ...written, edited: true }, AMSTERDAM)).toBe("Week 1. Nienke Visser, 16 September, edited");
    expect(entryMetaLabel({ ...written, periodSequence: 2, late: true }, AMSTERDAM)).toBe("Week 2. Nienke Visser, added late");
    expect(entryMetaLabel({ ...written, late: true, edited: true }, AMSTERDAM)).toBe("Week 1. Nienke Visser, added late, edited");
    // The author's own entry reads exactly like anyone else's: no "(you)".
    expect(entryMetaLabel({ ...written, authorIsYou: true }, AMSTERDAM)).toBe("Week 1. Nienke Visser, 16 September");
  });

  it("words the Captains' Den meta line as the author and the day, saying You for the Captain's own note", () => {
    expect(captainMetaLabel(written, AMSTERDAM)).toBe("Nienke Visser, 16 September");
    expect(captainMetaLabel({ ...written, authorIsYou: true, submittedAt: "2026-09-15T10:00:00.000Z" }, AMSTERDAM)).toBe("You, 15 September");
  });

  it("links a contact only when it is shaped like a Telegram handle", () => {
    expect(telegramContactHref("@femkedj")).toBe("https://t.me/femkedj");
    expect(telegramContactHref("femkedj")).toBe("https://t.me/femkedj");
    expect(telegramContactHref(" @nienkev ")).toBe("https://t.me/nienkev");
    for (const contact of ["@abc", "someone@example.test", "https://t.me/femkedj", "@femke dj", "@femke-dj", "@" + "x".repeat(33), "", null, undefined]) {
      expect(telegramContactHref(contact), String(contact)).toBeNull();
    }
  });

  it("decides whether a week has started or is the current one from its own instants", () => {
    const before = Date.parse(WEEK_ONE.startsAt) - 1;
    const start = Date.parse(WEEK_ONE.startsAt);
    const end = Date.parse(WEEK_ONE.endsAt);
    expect(isWeekStarted(WEEK_ONE, before)).toBe(false);
    expect(isWeekStarted(WEEK_ONE, start)).toBe(true);
    expect(isWeekStarted(WEEK_ONE, end)).toBe(true);
    expect(isWeekCurrent(WEEK_ONE, before)).toBe(false);
    expect(isWeekCurrent(WEEK_ONE, start)).toBe(true);
    expect(isWeekCurrent(WEEK_ONE, end - 1)).toBe(true);
    expect(isWeekCurrent(WEEK_ONE, end)).toBe(false);
    expect(isWeekCurrent(WEEK_ONE, Number.NaN)).toBe(false);
  });

  it("carries the design's copy exactly", () => {
    expect(UPDATED_LABEL).toBe("Updated");
    expect(HEADING_OPEN).toBe("What moved this week?");
    expect(HEADING_DONE).toBe("Anything to add?");
    expect(UPDATE_SAVED).toBe("Update saved.");
    expect(SAVED_LABEL).toBe("Saved.");
    expect(NOTE_ADDED).toBe("Note added.");
    expect(EARLIER_NOTE).toBe("Updates, such as the weekly video or posts, made on Colosseum are automatically shown here.");
    expect(LATE_NOTE).toBe("Stays with the selected week. A missed week stays marked as missed.");
    expect(PRIVATE_TOOLTIP).toBe("Only visible to you and HQ admins");
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
    // `period_changed` is shown as one error line above a draft that stays
    // put, so it must not point at a week "named below" that no screen names.
    expect(ADD_UPDATE_MESSAGES.period_changed).toMatch(/text is kept/i);
    expect(ADD_UPDATE_MESSAGES.period_changed).toMatch(/open now/i);
    expect(ADD_UPDATE_MESSAGES.period_changed).not.toMatch(/below/i);
    // `conflict` is shown beside the saved version, which the entry card renders.
    expect(EDIT_UPDATE_MESSAGES.conflict).toMatch(/kept below/i);
  });

  it("describes each audience before the save rather than after it, and never claims a note completes the week", () => {
    expect(AUDIENCE_NOTES.shared).toMatch(/team/i);
    expect(AUDIENCE_NOTES.sensitive).toMatch(/admins/i);
    expect(AUDIENCE_NOTES.sensitive).toMatch(/never counts as an update from the team/i);
    for (const note of Object.values(AUDIENCE_NOTES)) expect(note).not.toMatch(/completes the week/i);
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
    UPDATED_LABEL,
    HEADING_OPEN,
    HEADING_DONE,
    UPDATE_SAVED,
    SAVED_LABEL,
    NOTE_ADDED,
    EARLIER_NOTE,
    LATE_NOTE,
    PRIVATE_TOOLTIP,
    missedLabel(2),
    periodRangeLabel("2026-09-14", "2026-10-04"),
    periodRangeShortLabel("2026-09-28", "2026-10-04"),
    deadlineLabel("2026-09-20"),
    dueLine(WEEK_ONE.endsAt, AMSTERDAM),
    weekOfLabel(1, 4),
    entryMetaLabel({ periodSequence: 2, authorName: "Nienke Visser", authorIsYou: false, late: true, edited: true, submittedAt: WEEK_ONE.endsAt }, AMSTERDAM),
    captainMetaLabel({ periodSequence: 1, authorName: "Nienke Visser", authorIsYou: true, late: false, edited: false, submittedAt: WEEK_ONE.startsAt }, AMSTERDAM),
  ];

  it("has no em dash and no middot anywhere in it", () => {
    for (const line of copy) expect(line, line).not.toMatch(/[—·]/);
  });

  it("leaves the reporting components free of them as well", () => {
    for (const file of [
      "components/hq/reporting-member.tsx",
      "components/hq/reporting-entry-card.tsx",
      "components/hq/builder-captain-den.tsx",
      "components/hq/reporting-admin.tsx",
      "components/hq/reporting-project-panel.tsx",
      // Phase 10's final period. Its copy lives in its own pure module
      // rather than in ./reporting-view, so the scan is extended to it
      // instead: the contract's rule is that reporting copy stays inside
      // this scan, and what matters is that it is covered.
      "lib/hq/submission-readiness.ts",
      "components/hq/submission-focus.tsx",
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
