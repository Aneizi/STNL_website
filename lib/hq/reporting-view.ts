import { UPDATE_LENGTH_HINT } from "./reporting-body";

// The reporting screens' presentation rules, as pure functions and copy.
//
// No `server-only`, no database handle and no session: this module is
// imported by client components and by tests alike, following the
// `lib/hq/member-routes.ts` and `lib/hq/reporting-periods.ts` pattern. Every
// decision here is about wording and layout. Nothing here is authorization,
// and nothing here re-derives what the service already answered: completion
// comes from `ProjectReportingStatus.current.completed`, a week's dates from
// the period, a refusal's meaning from the service's own reason.
//
// Copy rule, from the plan's phase 6 acceptance: no em dashes and no
// middots in interface text, and no unnecessary technical terminology.
// `tests/hq/reporting-view.test.ts` scans the strings in this file for both.

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Merge refreshed/saved updates with already loaded pages, without duplicates or reverting a newer edit. */
export function mergeUpdatePages<T extends { id: string; version: number; submittedAt: string }>(current: readonly T[], incoming: readonly T[]): T[] {
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of incoming) {
    if ((byId.get(entry.id)?.version ?? 0) <= entry.version) byId.set(entry.id, entry);
  }
  return [...byId.values()].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || b.id.localeCompare(a.id));
}

/**
 * How long a contact line may be: longer than any handle, email or short
 * line someone would type, short enough that a card never has to truncate a
 * paragraph. Here rather than beside the queries because the field that
 * enforces it is a client component, and `lib/hq/reporting-contacts.ts` is
 * server only; that module re-exports both of these unchanged.
 */
export const MAX_CONTACT_LENGTH = 200;

/** Trimmed text, or null for anything empty. The one normalisation, applied on every write. */
export function normalizeContact(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, MAX_CONTACT_LENGTH) : null;
}

/** The two words a week's state is ever described in. Weekly status is binary; there is no third state. */
export const REPORTING_STATUS_LABELS = { updated: "Updated", missed: "Not updated" } as const;

export const statusLabel = (completed: boolean): string =>
  completed ? REPORTING_STATUS_LABELS.updated : REPORTING_STATUS_LABELS.missed;

/**
 * A period's inclusive local dates as one line: "14 to 21 September", or
 * "28 September to 5 October" across a month boundary.
 *
 * Always the inclusive `startDate`/`endDate` a period carries for display,
 * never `endsAt`, which is the exclusive instant a comparison uses and is
 * local midnight on the following day.
 */
export function periodRangeLabel(startDate: string, endDate: string): string {
  if (!startDate || !endDate) return "";
  const [, sm, sd] = startDate.split("-").map(Number);
  const [, em, ed] = endDate.split("-").map(Number);
  const month = (n: number) => MONTHS[n - 1] ?? "";
  if (sm === em && sd === ed) return `${sd} ${month(sm)}`;
  if (sm === em) return `${sd} to ${ed} ${month(em)}`;
  return `${sd} ${month(sm)} to ${ed} ${month(em)}`;
}

/** The weekday name of a local date, so a deadline reads the way people say it. */
export function weekdayName(isoDate: string): string {
  const at = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(at)) return "";
  return DAYS[(new Date(at).getUTCDay() + 6) % 7];
}

/** "Sunday 21 September" — the last day a week's update still counts, said as a day rather than an instant. */
export function deadlineLabel(endDate: string): string {
  if (!endDate) return "";
  const [, m, d] = endDate.split("-").map(Number);
  return `${weekdayName(endDate)} ${d} ${MONTHS[m - 1] ?? ""}`;
}

/** "Week 1 of 4": where the campaign is, as the Home tile, the team page and the Captains' Den all say it. */
export const weekOfLabel = (sequence: number, total: number): string => `Week ${sequence} of ${total}`;

/** The named parts of one instant in the campaign timezone, keyed by part type. */
function zonedParts(atMs: number, timezone: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-GB", { timeZone: timezone, ...options }).formatToParts(new Date(atMs))) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return parts;
}

/**
 * "Sunday 20 September, 23:59 CEST": the last minute of a week, in the
 * campaign timezone.
 *
 * `endsAt` is the exclusive instant the service compares against, which is
 * local midnight on the day AFTER the week's last day. Stepping back one
 * minute lands on the last minute that still counts, so the label names the
 * day people mean and the zone the clock is actually in (CEST in September,
 * CET in the winter weeks) rather than a hard-coded pair.
 */
export function dueLabel(endsAt: string, timezone: string): string {
  const at = Date.parse(endsAt);
  if (!Number.isFinite(at)) return "";
  const parts = zonedParts(at - 60_000, timezone, {
    weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
  });
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

/** The kicker's underlined half while the week is still open: "Due Sunday 20 September, 23:59 CEST". */
export const dueLine = (endsAt: string, timezone: string): string => `Due ${dueLabel(endsAt, timezone)}`;

/**
 * The late-update modal's week buttons: "14 to 20 Sep", "28 Sep to 4 Oct".
 * Three-letter months, and the month once when both days share it, so a
 * button 110px wide still fits its range on one line.
 */
export function periodRangeShortLabel(startDate: string, endDate: string): string {
  if (!startDate || !endDate) return "";
  const [, sm, sd] = startDate.split("-").map(Number);
  const [, em, ed] = endDate.split("-").map(Number);
  const month = (n: number) => (MONTHS[n - 1] ?? "").slice(0, 3);
  if (sm === em && sd === ed) return `${sd} ${month(sm)}`;
  if (sm === em) return `${sd} to ${ed} ${month(em)}`;
  return `${sd} ${month(sm)} to ${ed} ${month(em)}`;
}

/** "16 September": the day an update was written, in the campaign timezone rather than the browser's. */
export function dayMonthLabel(isoInstant: string, timezone: string): string {
  const at = Date.parse(isoInstant);
  if (!Number.isFinite(at)) return "";
  const parts = zonedParts(at, timezone, { day: "numeric", month: "long" });
  return `${parts.day} ${parts.month}`;
}

/** What an entry card's meta line is built from. Structural, so this module needs nothing from the server-only service. */
type EntryMetaInput = {
  periodSequence: number;
  authorName: string;
  authorIsYou: boolean;
  late: boolean;
  edited: boolean;
  submittedAt: string;
};

/**
 * The team page's meta line: "Week 1. Nienke Visser, 16 September", with
 * "added late" in place of the date for a late entry and ", edited" once
 * when the text changed since. Never "(you)" and never an ISO date.
 */
export function entryMetaLabel(entry: EntryMetaInput, timezone: string): string {
  const when = entry.late ? "added late" : dayMonthLabel(entry.submittedAt, timezone);
  return `Week ${entry.periodSequence}. ${entry.authorName}, ${when}${entry.edited ? ", edited" : ""}`;
}

/** The Captains' Den meta line: "You, 15 September" for the Captain's own note, "Nienke Visser, 16 September" for the team's. */
export function captainMetaLabel(entry: EntryMetaInput, timezone: string): string {
  return `${entry.authorIsYou ? "You" : entry.authorName}, ${dayMonthLabel(entry.submittedAt, timezone)}`;
}

/**
 * A Telegram handle, with or without its "@", as the only shape a contact
 * line is ever turned into a link. Contacts are free text somebody typed;
 * anything that is not a handle is rendered as text, never as an href.
 */
const TELEGRAM_HANDLE = /^@?[A-Za-z0-9_]{5,32}$/;

export function telegramContactHref(contact: string | null | undefined): string | null {
  const text = String(contact ?? "").trim();
  return TELEGRAM_HANDLE.test(text) ? `https://t.me/${text.replace(/^@/, "")}` : null;
}

/** Week boundaries use the same `startsAt`/`endsAt` instants the service compares. */
export const isWeekStarted = (period: { startsAt: string }, nowMs: number): boolean => Date.parse(period.startsAt) <= nowMs;

export const isWeekCurrent = (period: { startsAt: string; endsAt: string }, nowMs: number): boolean =>
  isWeekStarted(period, nowMs) && nowMs < Date.parse(period.endsAt);

export const isWeekEnded = (period: { endsAt: string }, nowMs: number): boolean => Date.parse(period.endsAt) <= nowMs;

/** The kicker's underlined half once the week is done. */
export const UPDATED_LABEL = "Updated";
/** The composer heading while the week still needs an update, and once it has one. */
export const HEADING_OPEN = "What moved this week?";
export const HEADING_DONE = "Anything to add?";
/** The inline status lines the member forms show. Never a toast. */
export const UPDATE_SAVED = "Update saved.";
export const SAVED_LABEL = "Saved.";
export const NOTE_ADDED = "Note added.";
/** Under the Earlier heading on the team page. */
export const EARLIER_NOTE = "Updates, such as the weekly video or posts, made on Colosseum are automatically shown here.";
/** In the late-update modal, under the textarea. */
export const LATE_NOTE = "Stays with the selected week. A missed week stays marked as missed.";
/** The Keep private tooltip on the Captains' Den, and the title of a private note's tag. */
export const PRIVATE_TOOLTIP = "Only visible to you and HQ admins";

/**
 * What each refusal from `createUpdate` means, in words the person can act
 * on. One message per reason, never collapsed into a generic error: the rule
 * phase 3 set for imports, applied to reporting.
 * `period_changed` and `conflict` also carry data, which the composer uses;
 * these are only their wording.
 */
export const ADD_UPDATE_MESSAGES = {
  not_authorized: "This team is not available to your account.",
  empty_body: "Write your update before saving it.",
  body_too_long: `This update is too long. ${UPDATE_LENGTH_HINT}`,
  not_eligible: "This team is not in weekly reporting yet. Ask Superteam NL to add it.",
  no_open_period: "There is no open reporting week right now, so there is nothing to update.",
  period_not_found: "That reporting week is not part of this hackathon.",
  period_changed: "The week changed while you were writing. Your text is kept; add it to the week that is open now.",
  visibility_not_allowed: "Only the team's Captain can save a note as sensitive.",
} as const;

/** The same, for `editUpdate`. `conflict` keeps the unsaved text on screen beside the version that is saved now. */
export const EDIT_UPDATE_MESSAGES = {
  not_found: "That update is no longer there.",
  not_authorized: "This update is not yours to change.",
  empty_body: "An update cannot be empty. Write something, or ask an admin to remove it.",
  body_too_long: `This update is too long. ${UPDATE_LENGTH_HINT}`,
  conflict: "This update changed while you were editing. Your text is kept below, next to the version that is saved now.",
  voided: "An admin removed this update, so it can no longer be edited.",
  visibility_not_allowed: "Only the team's Captain can save a note as sensitive.",
  audience_not_confirmed: "Confirm who will be able to read this note before sharing it with the team.",
} as const;

/**
 * What each audience means, said before the save rather than after it. Both
 * are a Captain's choices, and neither kind of note counts as the team's
 * update: the team's week stays Not updated until a team member writes one.
 */
export const AUDIENCE_NOTES = {
  shared: "Shared with the team, their Captain and Superteam NL admins.",
  sensitive: "Kept between you and Superteam NL admins. The team does not see it, and it never counts as an update from the team.",
} as const;


/** How a project's missed weeks read on a card, or an empty string when none. */
export function missedLabel(missedPeriods: number): string {
  if (missedPeriods <= 0) return "";
  return missedPeriods === 1 ? "1 week missed" : `${missedPeriods} weeks missed`;
}

/** Colosseum's own signal, in the words the rest of HQ already uses for it. Kept distinct from the weekly words above. */
export const SUBMISSION_FILTER_LABEL = "Not submitted";

/**
 * Card ordering for a Captain or an admin: the work first. Not updated
 * before updated, more missed weeks before fewer, then by name so a list
 * with nothing to choose between is still stable.
 */
export function byOutstandingFirst(
  a: { current: { completed: boolean } | null; missedPeriods: number; projectName: string },
  b: { current: { completed: boolean } | null; missedPeriods: number; projectName: string },
): number {
  const open = (row: typeof a) => (row.current && !row.current.completed ? 0 : 1);
  return open(a) - open(b) || b.missedPeriods - a.missedPeriods || a.projectName.localeCompare(b.projectName);
}

/**
 * The Admin page's Reporting weeks column: "14 Sep to 20 Sep", "28 Sep to
 * 4 Oct". Both ends always carry their month, unlike periodRangeShortLabel
 * above, so a column of weeks scans as two aligned dates.
 */
export function shortPeriodRange(startDate: string, endDate: string): string {
  if (!startDate || !endDate) return "";
  const dayMonth = (iso: string) => {
    const [, m, d] = iso.split("-").map(Number);
    return `${d} ${(MONTHS[m - 1] ?? "").slice(0, 3)}`;
  };
  return `${dayMonth(startDate)} to ${dayMonth(endDate)}`;
}

/**
 * "16 Sep 20:00": when the queue will try a reminder again, in the campaign
 * timezone. The month comes from MONTHS rather than the locale, whose
 * en-GB abbreviation of September is "Sept".
 */
export function fmtRetryAt(isoInstant: string, timezone: string): string {
  const at = Date.parse(isoInstant);
  if (!Number.isFinite(at)) return "";
  const parts = zonedParts(at, timezone, { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  // A numeric month pads the day to two digits in en-GB; the design prints "4 Oct".
  return `${Number(parts.day)} ${(MONTHS[Number(parts.month) - 1] ?? "").slice(0, 3)} ${parts.hour}:${parts.minute}`;
}
