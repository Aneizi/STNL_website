/**
 * Pure generation of reporting windows from campaign dates and timezone.
 * Displayed dates are inclusive; UTC intervals are [startsAt, endsAt), with
 * adjacent periods sharing a boundary. The final end is local midnight after
 * the campaign's last day. An explicit final-period start merges the remaining
 * weeks; dates and nudge settings always come from configuration.
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
   * The submission period's first local day, or null for weekly reporting.
   * Merge remaining weeks through endDate; truncate an interrupted week.
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
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const at = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}

/** Calendar-day arithmetic on an ISO date, done in UTC so no local offset or clock change can shift the day. */
export function addDays(iso: string, days: number): string {
  const at = Date.parse(`${iso}T00:00:00Z`);
  if (!isCalendarDate(iso)) throw new RangeError(`Not an ISO date: ${iso}`);
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
 * Zone offset in milliseconds, derived from the local wall clock.
 * Use h23 because some ICU builds render midnight as hour 24 with hour12:false.
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
 * Resolve local date/time to UTC using the offset at the naive UTC reading,
 * then one correction at the resulting guess. Spring-forward gaps follow that
 * offset calculation rather than being rejected as nonexistent local times.
 */
export function zonedDateTimeToUtc(date: string, time: string, timezone: string): Date {
  if (!isCalendarDate(date)) throw new RangeError(`Not an ISO date: ${date}`);
  const match = TIME.exec(time);
  if (!match) throw new RangeError(`Not an HH:MM time: ${time}`);
  const naive = Date.parse(`${date}T${match[1]}:${match[2]}:00Z`);
  if (!Number.isFinite(naive)) throw new RangeError(`Not an ISO date and time: ${date} ${time}`);
  const guess = naive - zoneOffsetMs(new Date(naive), timezone);
  return new Date(naive - zoneOffsetMs(new Date(guess), timezone));
}

/**
 * Format an instant as YYYY-MM-DDTHH:MM in the campaign timezone for a
 * datetime-local input. Slicing UTC text would shift the next saved deadline.
 */
export function utcToZonedDateTime(instant: Date | string | number, timezone: string): string {
  const at = instant instanceof Date ? instant : new Date(instant);
  if (!Number.isFinite(at.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** Local midnight that begins `date`, as a UTC instant. */
const localMidnight = (date: string, timezone: string) => zonedDateTimeToUtc(date, "00:00", timezone);

/**
 * Consecutive seven-day local ranges, shortened by the campaign end or
 * the configured submission-period merge boundary.
 */
function periodDateRanges(schedule: ReportingSchedule): { mode: ReportingPeriodMode; startDate: string; endDate: string }[] {
  const { startDate, endDate } = schedule;
  if (!isCalendarDate(startDate) || !isCalendarDate(endDate) || daysBetween(startDate, endDate) < 0) return [];
  // A final start outside the campaign is not a schedule anyone can act on,
  // so it is ignored rather than clamped: clamping would silently relabel
  // every week as the submission period, or none of it, on a typo.
  const finalStart = schedule.finalPeriodStartDate && isCalendarDate(schedule.finalPeriodStartDate)
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
 * Generate stable, ordered periods so stored rows can be compared by sequence
 * before applying a schedule change.
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
 * The first configured nudge weekday/time within the period, or null.
 * Never move an out-of-range nudge into another period.
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
 * Find the interval [startsAt, endsAt); a boundary save belongs to the new period.
 */
export function periodForInstant<T extends { startsAt: string; endsAt: string }>(periods: readonly T[], instantMs: number): T | null {
  return periods.find((period) => Date.parse(period.startsAt) <= instantMs && instantMs < Date.parse(period.endsAt)) ?? null;
}
