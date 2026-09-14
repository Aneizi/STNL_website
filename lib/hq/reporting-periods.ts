/**
 * Reporting periods, derived rather than stored twice.
 *
 * The campaign's own record is the input: `hq_hackathons.start_date` and
 * `end_date` are local dates, and the timezone is the campaign's
 * (`hq_settings.timezone`, Europe/Amsterdam for this edition). This module
 * turns those into the weekly windows the plan's Phase 5 table names, plus
 * the one submission-focus window an explicit final-period start merges the
 * remaining weeks into.
 *
 * Three rules the plan sets, and how each is met:
 *
 * 1. **"Make period ends exclusive internally, while displaying inclusive
 *    local dates."** Every period carries both: `startDate`/`endDate` are the
 *    inclusive local dates a screen prints, `startsAt`/`endsAt` are UTC
 *    instants with an exclusive end. `endsAt` of one period is exactly
 *    `startsAt` of the next, so no instant belongs to two periods and none
 *    falls between them.
 * 2. **"There is no fifth period beginning 12 October."** The last period's
 *    exclusive end is local midnight on the day *after* `end_date`, so the
 *    campaign's final day is inside the final period rather than the first
 *    day of a new one.
 * 3. **"Generate periods from database configuration, including an explicit
 *    final-period start/merge setting, rather than hardcoding these dates
 *    into components."** Nothing here knows 2026: the dates, the timezone,
 *    the final-period start and the nudge weekday and time all arrive as
 *    configuration.
 *
 * Pure, with no `server-only` and no database handle, following the
 * `lib/hq/luma-sync-sql.ts` pattern: the period table in the plan can then be
 * asserted literally in a test, including its UTC instants.
 */

export type ReportingPeriodMode = "weekly" | "submission";

export type ReportingSchedule = {
  /** `hq_hackathons.start_date`: the first local day of reporting, inclusive. */
  startDate: string;
  /** `hq_hackathons.end_date`: the last local day of reporting, inclusive. */
  endDate: string;
  /** The campaign timezone (`hq_settings.timezone`), an IANA name. */
  timezone: string;
  /**
   * The local day the submission-focus period starts on, or null for a purely
   * weekly schedule. Every weekly period that would begin on or after it is
   * merged into one period running to `endDate`; a weekly period it
   * interrupts mid-week is truncated the day before it.
   */
  finalPeriodStartDate: string | null;
  /** ISO weekday of the mid-period nudge, 1 Monday to 7 Sunday. */
  nudgeWeekday: number;
  /** Local time of day of the nudge, "HH:MM". */
  nudgeTime: string;
};

export type GeneratedPeriod = {
  /** 1-based position in the campaign; the stable identity a stored period keeps. */
  sequence: number;
  mode: ReportingPeriodMode;
  /** Inclusive local dates, what a screen displays. */
  startDate: string;
  endDate: string;
  /** UTC instants, what a comparison uses. `endsAt` is exclusive. */
  startsAt: string;
  endsAt: string;
  /** The nudge instant, or null when the configured weekday falls outside this period. */
  nudgeAt: string | null;
};

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(\d{2}):(\d{2})$/;

/** Calendar-day arithmetic on an ISO date, done in UTC so no local offset or clock change can shift the day. */
export function addDays(iso: string, days: number): string {
  const at = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(at)) throw new RangeError(`Not an ISO date: ${iso}`);
  return new Date(at + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to`; negative when `to` is earlier. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** ISO weekday, 1 Monday to 7 Sunday, of a local date. */
function isoWeekday(iso: string): number {
  return ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

/**
 * How far the zone is ahead of UTC at a given instant, in milliseconds.
 * `formatToParts` in the target zone gives that instant's local wall clock;
 * reading it back as if it were UTC and subtracting the instant is the
 * offset. `hourCycle: "h23"` rather than `hour12: false`, because the latter
 * renders local midnight as hour 24 in some ICU builds.
 */
function zoneOffsetMs(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - instant.getTime();
}

/**
 * The UTC instant of a local date and time in a zone.
 *
 * The offset depends on the instant, and the instant is what is being solved
 * for, so this guesses with the offset at the naive reading and then corrects
 * once with the offset at the guess. One correction is enough for every real
 * zone: the second guess is already within the same offset as the answer
 * except inside the one-hour gap a spring-forward creates, where no such
 * local time exists at all and the result lands on the instant the clock
 * jumped to.
 */
export function zonedDateTimeToUtc(date: string, time: string, timezone: string): Date {
  if (!DATE.test(date)) throw new RangeError(`Not an ISO date: ${date}`);
  const match = TIME.exec(time);
  if (!match) throw new RangeError(`Not an HH:MM time: ${time}`);
  const naive = Date.parse(`${date}T${match[1]}:${match[2]}:00Z`);
  if (!Number.isFinite(naive)) throw new RangeError(`Not an ISO date and time: ${date} ${time}`);
  const guess = naive - zoneOffsetMs(new Date(naive), timezone);
  return new Date(naive - zoneOffsetMs(new Date(guess), timezone));
}

/** Local midnight that begins `date`, as a UTC instant. */
const localMidnight = (date: string, timezone: string) => zonedDateTimeToUtc(date, "00:00", timezone);

/**
 * The inclusive local dates of every period, before they are turned into
 * instants: consecutive seven-day windows from the campaign's first day,
 * with the merge rule applied. Split out so the merge is one readable
 * decision rather than a condition inside the instant arithmetic.
 */
function periodDateRanges(schedule: ReportingSchedule): { mode: ReportingPeriodMode; startDate: string; endDate: string }[] {
  const { startDate, endDate } = schedule;
  if (!DATE.test(startDate) || !DATE.test(endDate) || daysBetween(startDate, endDate) < 0) return [];
  // A final start outside the campaign is not a schedule anyone can act on,
  // so it is ignored rather than clamped: clamping would silently relabel
  // every week as the submission period, or none of it, on a typo.
  const finalStart = schedule.finalPeriodStartDate && DATE.test(schedule.finalPeriodStartDate)
    && daysBetween(startDate, schedule.finalPeriodStartDate) >= 0
    && daysBetween(schedule.finalPeriodStartDate, endDate) >= 0
    ? schedule.finalPeriodStartDate
    : null;

  const ranges: { mode: ReportingPeriodMode; startDate: string; endDate: string }[] = [];
  let cursor = startDate;
  while (daysBetween(cursor, endDate) >= 0) {
    if (finalStart && daysBetween(finalStart, cursor) >= 0) {
      ranges.push({ mode: "submission", startDate: cursor, endDate });
      return ranges;
    }
    // The week runs seven days, unless the campaign or the final period ends
    // first; `endDate` is inclusive, so the week's own last day is the day
    // before whichever boundary comes next.
    const weekEnd = addDays(cursor, 6);
    const boundaries = [weekEnd, endDate, ...(finalStart ? [addDays(finalStart, -1)] : [])];
    const last = boundaries.reduce((earliest, day) => (daysBetween(day, earliest) > 0 ? day : earliest));
    ranges.push({ mode: "weekly", startDate: cursor, endDate: last });
    cursor = addDays(last, 1);
  }
  return ranges;
}

/**
 * The campaign's periods, in order. Every returned period is stable under
 * repeated calls with the same schedule: that is what lets a stored period
 * row be matched to a generated one by `sequence` and compared field by
 * field before a live schedule is changed.
 */
export function generateReportingPeriods(schedule: ReportingSchedule): GeneratedPeriod[] {
  const { timezone } = schedule;
  return periodDateRanges(schedule).map((range, index) => {
    const startsAt = localMidnight(range.startDate, timezone);
    // Exclusive: local midnight of the day after the period's last day.
    const endsAt = localMidnight(addDays(range.endDate, 1), timezone);
    return {
      sequence: index + 1,
      mode: range.mode,
      startDate: range.startDate,
      endDate: range.endDate,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      nudgeAt: nudgeInstant(range, schedule),
    };
  });
}

/**
 * The first configured nudge weekday on or after the period's first day, at
 * the configured local time, or null when that day falls outside the period.
 * A nudge nobody could still act on inside its own period is not a nudge, so
 * it is left unset rather than pushed into the neighbouring week.
 */
function nudgeInstant(range: { startDate: string; endDate: string }, schedule: ReportingSchedule): string | null {
  const weekday = Math.trunc(schedule.nudgeWeekday);
  if (!Number.isFinite(weekday) || weekday < 1 || weekday > 7) return null;
  if (!TIME.test(schedule.nudgeTime)) return null;
  const offset = (weekday - isoWeekday(range.startDate) + 7) % 7;
  const day = addDays(range.startDate, offset);
  if (daysBetween(day, range.endDate) < 0) return null;
  return zonedDateTimeToUtc(day, schedule.nudgeTime, schedule.timezone).toISOString();
}

/**
 * The period an instant falls in, or null outside the campaign. The start is
 * inclusive and the end exclusive, so a save at a boundary belongs to the
 * period that is opening, never to the one that just closed.
 */
export function periodForInstant<T extends { startsAt: string; endsAt: string }>(periods: readonly T[], instantMs: number): T | null {
  return periods.find((period) => Date.parse(period.startsAt) <= instantMs && instantMs < Date.parse(period.endsAt)) ?? null;
}
