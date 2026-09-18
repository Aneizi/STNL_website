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

/** ISO weekday (1 Monday to 7 Sunday) of an instant in the campaign timezone. */
export function weekdayInZone(atMs: number, timezone: string): number {
  const label = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(new Date(atMs));
  const index = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(label);
  return index < 0 ? 0 : index + 1;
}

/** The days HQ nudges on while the week's update is missing: Monday and Tuesday, per the plan. */
const PROMPT_WEEKDAYS: ReadonlySet<number> = new Set([1, 2]);

export type PromptInput = {
  /** The open period's state, from `ProjectReportingStatus.current`; null outside the campaign. */
  current: { completed: boolean; startsAt: string; endsAt: string } | null;
  atMs: number;
  timezone: string;
  paused: boolean;
};

/**
 * Whether to show the update prompt for one project right now.
 *
 * Monday or Tuesday in the campaign timezone, a period actually open at this
 * instant, the week not already complete and the project not paused. The
 * prompt is a statement about the week, so completion is what stops it: a
 * dismissal only hides this browser's copy of it, and the inline Add update
 * action stays either way ("retain an inline action and stop prompting after
 * completion").
 */
export function shouldPromptUpdate({ current, atMs, timezone, paused }: PromptInput): boolean {
  if (paused || !current || current.completed) return false;
  if (!(Date.parse(current.startsAt) <= atMs && atMs < Date.parse(current.endsAt))) return false;
  return PROMPT_WEEKDAYS.has(weekdayInZone(atMs, timezone));
}

/**
 * Where a dismissal is remembered: this browser, keyed by project and
 * period, so dismissing one week never silences the next and dismissing one
 * team never silences another. Deliberately not a table: a dismissal is a
 * presentation preference with no audience and no history, the outstanding
 * action stays on the dashboard regardless, and the service stores none.
 */
export const promptDismissKey = (projectId: string, periodId: string): string =>
  `hq.reporting.prompt.${projectId}.${periodId}`;

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
  body_too_long: "This update is too long. Shorten it and save again.",
  not_eligible: "This team is not in weekly reporting yet. Ask Superteam NL to add it.",
  no_open_period: "There is no open reporting week right now, so there is nothing to update.",
  period_not_found: "That reporting week is not part of this hackathon.",
  period_changed: "A new reporting week started while you were writing. Your text is still here. Check the week named below, then save again.",
  visibility_not_allowed: "Only the team's Captain can save a note as sensitive.",
} as const;

/** The same, for `editUpdate`. `conflict` keeps the unsaved text on screen beside the version that is saved now. */
export const EDIT_UPDATE_MESSAGES = {
  not_found: "That update is no longer there.",
  not_authorized: "This update is not yours to change.",
  empty_body: "An update cannot be empty. Write something, or ask an admin to remove it.",
  body_too_long: "This update is too long. Shorten it and save again.",
  conflict: "This update changed while you were editing. Your text is kept below, next to the version that is saved now.",
  voided: "An admin removed this update, so it can no longer be edited.",
  visibility_not_allowed: "Only the team's Captain can save a note as sensitive.",
  audience_not_confirmed: "Confirm who will be able to read this note before sharing it with the team.",
} as const;

/** What each audience means, said before the save rather than after it. */
export const AUDIENCE_NOTES = {
  shared: "Shared with the team, their Captain and Superteam NL admins.",
  sensitive: "Kept between you and Superteam NL admins. The team does not see it, and it still completes the week.",
} as const;

/** The empty state of a project's update list, per audience. */
export const NO_UPDATES_YET = "No updates yet for this week.";

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
