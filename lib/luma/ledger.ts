/**
 * Presentation adapter for the public /events ledger. Everything here exists
 * to serve components/events-ledger.tsx — tints, split date parts, clock
 * ranges. HQ shares the fetch and the normalize step below it, not this.
 */

import { fetchCalendarEntries, REVALIDATE_SECONDS } from "./client";
import { toLumaEvent, type NormalizedLumaEvent } from "./normalize";

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

/**
 * Split parts of a "YYYY-MM-DD" calendar day. The day is already resolved in
 * the event's timezone upstream, so it is formatted as UTC here — reapplying a
 * timezone to a bare date would shift it.
 */
function dateParts(isoDay: string): EventDateParts {
  const at = new Date(`${isoDay}T00:00:00Z`);
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(at);
  return {
    dow: part({ weekday: "short" }),
    day: part({ day: "2-digit" }),
    mon: part({ month: "short" }),
  };
}

function monthLabel(isoDay: string): string {
  const at = new Date(`${isoDay}T00:00:00Z`);
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(at);
  const year = part({ year: "numeric" });
  const month = part({ month: "long" });
  return year === new Date().getFullYear().toString() ? month : `${month} ${year}`;
}

/** "19:00–21:00", or just the start when Luma has no end time. */
function timeRange(ev: NormalizedLumaEvent): string {
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: ev.timezone,
    }).format(new Date(iso));
  const start = fmt(ev.startAt);
  return ev.endAt ? `${start}–${fmt(ev.endAt)}` : start;
}

/** Multi-day events read as a duration; single-day ones as a clock range. */
function whenLabel(ev: NormalizedLumaEvent): string {
  return ev.endDate ? `${ev.days} days` : timeRange(ev);
}

async function load(period: "upcoming" | "past"): Promise<NormalizedLumaEvent[]> {
  const entries = await fetchCalendarEntries(period, { revalidate: REVALIDATE_SECONDS });
  return entries.map(toLumaEvent);
}

export async function getUpcomingEvents(): Promise<LedgerEvent[]> {
  const events = await load("upcoming");
  let featuredIndex = 0;
  return events
    .slice()
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))
    .map((ev) => ({
      id: ev.lumaId,
      title: ev.name,
      blurb: ev.blurb,
      venue: ev.venue,
      city: ev.city,
      ...dateParts(ev.date),
      monthLabel: monthLabel(ev.date),
      time: whenLabel(ev),
      end: ev.endDate ? dateParts(ev.endDate) : null,
      days: ev.days,
      live: ev.live,
      img: ev.coverUrl,
      tint: ev.featured ? TINTS[featuredIndex++ % TINTS.length] : TINTS[0],
      featured: ev.featured,
      url: ev.url,
    }));
}

export async function getPastEvents(): Promise<PastLedgerEvent[]> {
  const events = await load("past");
  return events
    .slice()
    .sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt))
    .map((ev) => ({
      id: ev.lumaId,
      title: ev.name,
      venue: ev.venue,
      city: ev.city,
      ...dateParts(ev.date),
      time: whenLabel(ev),
      end: ev.endDate ? dateParts(ev.endDate) : null,
      days: ev.days,
    }));
}
