// Pure date/format helpers shared by server queries and client screens.
// String math on ISO dates avoids timezone drift; anything time-of-day
// aware takes the campaign timezone from settings.

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "2026-08-06" -> "Aug 6" */
export function fmtDate(iso: string): string {
  if (!iso) return "";
  const [, m, d] = iso.split("-");
  return `${MONTHS[+m - 1]} ${+d}`;
}

/** Full timestamps -> "Aug 6, 14:05" (in tz); date-only strings -> fmtDate. */
export function fmtWhen(ts: string, tz: string): string {
  if (!ts) return "";
  if (ts.length <= 10) return fmtDate(ts);
  const date = new Date(ts);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")} ${get("day")}, ${get("hour")}:${get("minute")}`;
}

/**
 * The request timestamp for force-dynamic pages. A named helper (rather than
 * a bare Date.now() in the page body) because every /hq page renders
 * per-request by design — this is request data, not render impurity.
 */
export function nowMs(): number {
  return Date.now();
}

/** Today as "YYYY-MM-DD" in the campaign timezone. */
export function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** "Friday 8 August 2026" — the dashboard's date line. */
export function todayLabel(tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());
}

/**
 * Whole calendar days between today (in the campaign timezone) and a date:
 * "in 51d" / "3d ago". Calendar math on ISO strings sidesteps DST and the
 * server's own timezone entirely.
 */
export function daysUntilLabel(iso: string, todayIso: string): string {
  const days = Math.round(
    (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86400000,
  );
  return days >= 0 ? `in ${days}d` : `${-days}d ago`;
}

/** Mirrors the design's stale check: over `staleDays` since last check-in. */
export function isStale(lastCheckIn: string, staleDays: number, nowMs: number): boolean {
  return (nowMs - new Date(lastCheckIn).getTime()) / 86400000 > staleDays;
}

/**
 * Coarse elapsed time for freshness labels: "4m ago", "3h ago", "2d ago".
 * `now` is passed in rather than read, so a server-rendered label and its
 * hydration agree.
 */
export function fmtAgo(iso: string, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - Date.parse(iso)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function fmtMoney(amount: number): string {
  return `$${amount.toLocaleString("en")}`;
}

/** Event-source matching, per the design: trimmed, case-insensitive. */
export function normName(s: string): string {
  return (s || "").trim().toLowerCase();
}
