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
const TINTS = ["#F7E4D4", "#DFE8F0", "#E4E9DB", "#F3EBD3"];

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
  time: string;
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
      return {
        id: ev.api_id || ev.url,
        title: ev.name,
        blurb: ev.description_snippet || ev.description || null,
        venue: venueOf(ev),
        city,
        dow: part(start, tz, { weekday: "short" }),
        day: part(start, tz, { day: "2-digit" }),
        mon: part(start, tz, { month: "short" }),
        monthLabel: monthLabel(start, tz),
        time: timeRange(ev, tz),
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
      return {
        id: ev.api_id || ev.url,
        title: ev.name,
        venue: venueOf(ev),
        city,
        dow: part(start, tz, { weekday: "short" }),
        day: part(start, tz, { day: "2-digit" }),
        mon: part(start, tz, { month: "short" }),
        time: timeRange(ev, tz),
      };
    });
}
