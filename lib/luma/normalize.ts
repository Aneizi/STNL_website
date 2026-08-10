/**
 * The neutral domain shape both consumers share: the public events ledger
 * renders it, the HQ sync mirrors it into Postgres. Nothing here is specific
 * to either — presentation lives in ./ledger, persistence in lib/hq/luma-sync.
 */

import type { LumaEntry, LumaEvent } from "./client";

const DEFAULT_TIMEZONE = "Europe/Amsterdam";

/** Our own calendar; listing it as a cohost of our own events reads oddly. */
const SELF_HOST = "superteam nl";

export type NormalizedLumaEvent = {
  /** event.api_id — stable across renames, so it is the sync's identity. */
  lumaId: string;
  name: string;
  startAt: string;
  endAt: string | null;
  timezone: string;
  /** Calendar day of startAt in the event's own timezone, "YYYY-MM-DD". */
  date: string;
  /** Calendar day of endAt, set only when the event spans multiple days. */
  endDate: string | null;
  /** Inclusive calendar-day span; 1 for single-day events. */
  days: number;
  venue: string | null;
  city: string;
  cohosts: string[];
  guestCount: number;
  tags: string[];
  coverUrl: string | null;
  blurb: string | null;
  url: string;
  featured: boolean;
  /** Started but not yet ended, as of this call. */
  live: boolean;
};

export function tagName(tag: unknown): string {
  if (typeof tag === "string") return tag;
  if (tag && typeof tag === "object") {
    const t = tag as { name?: unknown; slug?: unknown };
    if (typeof t.name === "string") return t.name;
    if (typeof t.slug === "string") return t.slug;
  }
  return "";
}

/** Calendar date (YYYY-MM-DD) of an instant in a given timezone. */
export function dateKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(date);
}

/** End day + inclusive count, or null when start and end share a calendar day. */
function multiDaySpan(
  ev: LumaEvent,
  timeZone: string,
): { endDate: string; days: number } | null {
  if (!ev.end_at) return null;
  const start = new Date(ev.start_at);
  const end = new Date(ev.end_at);
  if (end <= start) return null;
  const startKey = dateKey(start, timeZone);
  const endKey = dateKey(end, timeZone);
  if (startKey === endKey) return null;
  const days = Math.round((Date.parse(endKey) - Date.parse(startKey)) / 86_400_000) + 1;
  return { endDate: endKey, days };
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

/** Host display names, minus our own calendar. */
function cohostsOf(entry: LumaEntry): string[] {
  return (entry.hosts ?? [])
    .map((h) => (typeof h?.name === "string" ? h.name.trim() : ""))
    .filter((name) => name && name.toLowerCase() !== SELF_HOST);
}

export function toLumaEvent(entry: LumaEntry): NormalizedLumaEvent {
  const ev = entry.event;
  const timezone = ev.timezone || DEFAULT_TIMEZONE;
  const start = new Date(ev.start_at);
  const span = multiDaySpan(ev, timezone);
  const tags = (entry.tags ?? []).map(tagName).filter(Boolean);
  const now = Date.now();

  return {
    lumaId: ev.api_id,
    name: ev.name,
    startAt: ev.start_at,
    endAt: ev.end_at ?? null,
    timezone,
    date: dateKey(start, timezone),
    endDate: span?.endDate ?? null,
    days: span?.days ?? 1,
    venue: venueOf(ev),
    city: cityOf(ev),
    cohosts: cohostsOf(entry),
    guestCount: typeof entry.guest_count === "number" ? entry.guest_count : 0,
    tags,
    coverUrl: ev.cover_url || null,
    blurb: ev.description_snippet || ev.description || null,
    url: `https://luma.com/${ev.url}`,
    featured: tags.some((t) => t.trim().toLowerCase() === "featured"),
    live: Boolean(
      ev.end_at && Date.parse(ev.start_at) <= now && now <= Date.parse(ev.end_at),
    ),
  };
}
