/**
 * Live event data from Superteam NL's public Luma calendar (luma.com/stnl).
 * Uses the same zero-auth calendar endpoint the Luma web app calls; responses
 * are cached and revalidated server-side (ISR), so a Luma hiccup never takes
 * the page down between revalidations.
 */

const CALENDAR_API_ID = "cal-vZUgVHVuBRK7pSd"; // luma.com/stnl
const ENDPOINT = "https://api.lu.ma/calendar/get-items";
const REVALIDATE_SECONDS = 300;

/** Featured-card background tints, cycled per featured event. */
export const TINTS = ["#F7E4D4", "#DFE8F0", "#E4E9DB", "#F3EBD3"];

export type EventDateParts = {
  dow: string;
  day: string;
  mon: string;
};

export type LedgerEvent = {
  id: string;
  title: string;
  blurb: string | null;
  venue: string | null;
  city: string;
  dow: string;
  day: string;
  mon: string;
  monthLabel: string;
  /** Clock range for single-day events, duration ("6 days") for multi-day. */
  time: string;
  /** End-date parts when the event spans multiple calendar days. */
  end: EventDateParts | null;
  /** Inclusive calendar-day span; 1 for single-day events. */
  days: number;
  /** Started but not yet ended, as of the last revalidation. */
  live: boolean;
  img: string | null;
  tint: string;
  featured: boolean;
  url: string;
};

export type PastLedgerEvent = {
  id: string;
  title: string;
  venue: string | null;
  city: string;
  dow: string;
  day: string;
  mon: string;
  time: string;
  end: EventDateParts | null;
  days: number;
};

type LumaGeo = {
  city?: string | null;
  address?: string | null;
};

type LumaEvent = {
  api_id?: string;
  name: string;
  start_at: string;
  end_at?: string | null;
  timezone?: string | null;
  url: string;
  cover_url?: string | null;
  location_type?: string | null;
  description?: string | null;
  description_snippet?: string | null;
  geo_address_info?: LumaGeo | null;
};

type LumaEntry = {
  event: LumaEvent;
  tags?: unknown[];
};

function tagName(tag: unknown): string {
  if (typeof tag === "string") return tag;
  if (tag && typeof tag === "object") {
    const t = tag as { name?: unknown; slug?: unknown };
    if (typeof t.name === "string") return t.name;
    if (typeof t.slug === "string") return t.slug;
  }
  return "";
}

function isFeatured(entry: LumaEntry): boolean {
  return (entry.tags ?? []).some(
    (t) => tagName(t).trim().toLowerCase() === "featured"
  );
}

function part(
  date: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions
): string {
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(
    date
  );
}

function dateParts(date: Date, timeZone: string): EventDateParts {
  return {
    dow: part(date, timeZone, { weekday: "short" }),
    day: part(date, timeZone, { day: "2-digit" }),
    mon: part(date, timeZone, { month: "short" }),
  };
}

/** Calendar date (YYYY-MM-DD) of an instant in the event's timezone. */
function dateKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(date);
}

/** End parts + inclusive day count, or null when start and end share a calendar day. */
function multiDaySpan(
  ev: LumaEvent,
  timeZone: string
): { end: EventDateParts; days: number } | null {
  if (!ev.end_at) return null;
  const start = new Date(ev.start_at);
  const end = new Date(ev.end_at);
  if (end <= start) return null;
  const startKey = dateKey(start, timeZone);
  const endKey = dateKey(end, timeZone);
  if (startKey === endKey) return null;
  const days =
    Math.round((Date.parse(endKey) - Date.parse(startKey)) / 86_400_000) + 1;
  return { end: dateParts(end, timeZone), days };
}

function isLive(ev: LumaEvent): boolean {
  if (!ev.end_at) return false;
  const now = Date.now();
  return Date.parse(ev.start_at) <= now && now <= Date.parse(ev.end_at);
}

function timeRange(ev: LumaEvent, timeZone: string): string {
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone,
    }).format(new Date(iso));
  const start = fmt(ev.start_at);
  return ev.end_at ? `${start}–${fmt(ev.end_at)}` : start;
}

function cityOf(ev: LumaEvent): string {
  if (ev.location_type && ev.location_type !== "offline") return "Online";
  return ev.geo_address_info?.city || "Amsterdam";
}

/** Venue name, or null when Luma has no usable address (hidden/URL-only). */
function venueOf(ev: LumaEvent): string | null {
  const addr = ev.geo_address_info?.address?.trim();
  if (!addr || /^https?:\/\//i.test(addr)) return null;
  return addr;
}

function monthLabel(date: Date, timeZone: string): string {
  const month = part(date, timeZone, { month: "long" });
  const year = part(date, timeZone, { year: "numeric" });
  const currentYear = new Date().getFullYear().toString();
  return year === currentYear ? month : `${month} ${year}`;
}

async function fetchEntries(period: "upcoming" | "past"): Promise<LumaEntry[]> {
  const params = new URLSearchParams({
    calendar_api_id: CALENDAR_API_ID,
    pagination_limit: "100",
  });
  if (period === "past") params.set("period", "past");
  const res = await fetch(`${ENDPOINT}?${params}`, {
    headers: { accept: "application/json" },
    next: { revalidate: REVALIDATE_SECONDS },
  });
  if (!res.ok) throw new Error(`Luma responded ${res.status}`);
  const data = (await res.json()) as { entries?: LumaEntry[] };
  return data.entries ?? [];
}

export async function getUpcomingEvents(): Promise<LedgerEvent[]> {
  const entries = await fetchEntries("upcoming");
  let featuredIndex = 0;
  return entries
    .slice()
    .sort(
      (a, b) => Date.parse(a.event.start_at) - Date.parse(b.event.start_at)
    )
    .map((entry) => {
      const ev = entry.event;
      const tz = ev.timezone || "Europe/Amsterdam";
      const start = new Date(ev.start_at);
      const featured = isFeatured(entry);
      const city = cityOf(ev);
      const span = multiDaySpan(ev, tz);
      return {
        id: ev.api_id || ev.url,
        title: ev.name,
        blurb: ev.description_snippet || ev.description || null,
        venue: venueOf(ev),
        city,
        ...dateParts(start, tz),
        monthLabel: monthLabel(start, tz),
        time: span ? `${span.days} days` : timeRange(ev, tz),
        end: span?.end ?? null,
        days: span?.days ?? 1,
        live: isLive(ev),
        img: ev.cover_url || null,
        tint: featured ? TINTS[featuredIndex++ % TINTS.length] : TINTS[0],
        featured,
        url: `https://luma.com/${ev.url}`,
      };
    });
}

export async function getPastEvents(): Promise<PastLedgerEvent[]> {
  const entries = await fetchEntries("past");
  return entries
    .slice()
    .sort(
      (a, b) => Date.parse(b.event.start_at) - Date.parse(a.event.start_at)
    )
    .map((entry) => {
      const ev = entry.event;
      const tz = ev.timezone || "Europe/Amsterdam";
      const start = new Date(ev.start_at);
      const city = cityOf(ev);
      const span = multiDaySpan(ev, tz);
      return {
        id: ev.api_id || ev.url,
        title: ev.name,
        venue: venueOf(ev),
        city,
        ...dateParts(start, tz),
        time: span ? `${span.days} days` : timeRange(ev, tz),
        end: span?.end ?? null,
        days: span?.days ?? 1,
      };
    });
}
