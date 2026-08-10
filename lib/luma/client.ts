/**
 * Transport for Superteam NL's public Luma calendar (luma.com/stnl).
 *
 * Uses the same zero-auth calendar endpoint the Luma web app calls. Two
 * consumers share it with different caching needs: the public /events page
 * caches with ISR, while the HQ sync passes no-store explicitly rather than
 * relying on its route's force-dynamic to imply it.
 */

const CALENDAR_API_ID = "cal-vZUgVHVuBRK7pSd"; // luma.com/stnl
const ENDPOINT = "https://api.lu.ma/calendar/get-items";

export const REVALIDATE_SECONDS = 300;

const PAGE_SIZE = 100;

/**
 * Runaway guard. At 100 entries a page this is 2000 events — far beyond the
 * calendar's real size, so hitting it means the cursor stopped advancing.
 * Reaching it is an error, never a truncated success: HQ archives events by
 * their absence from the response, so a short read would archive real history.
 */
const MAX_PAGES = 20;

export type LumaPeriod = "upcoming" | "past";

/** ISR for the public page; "no-store" for the HQ sync. */
export type LumaCache = { revalidate: number } | "no-store";

type LumaGeo = {
  city?: string | null;
  address?: string | null;
};

export type LumaEvent = {
  api_id: string;
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

export type LumaHost = {
  name?: string | null;
};

export type LumaEntry = {
  event: LumaEvent;
  tags?: unknown[];
  hosts?: LumaHost[] | null;
  guest_count?: number | null;
};

type LumaPage = {
  entries: LumaEntry[];
  has_more: boolean;
  next_cursor: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Strict, because absence drives archiving downstream. A body we cannot read
 * must throw rather than degrade into "the calendar is empty" — an empty
 * `entries` array is a legitimate answer, a missing one is not.
 */
function parsePage(body: unknown): LumaPage {
  if (!isRecord(body)) throw new Error("Luma returned a non-object body");
  const { entries, has_more: hasMore, next_cursor: nextCursor } = body;
  if (!Array.isArray(entries)) throw new Error("Luma response has no entries array");
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.event)) {
      throw new Error("Luma entry has no event object");
    }
    const { api_id: apiId, name, start_at: startAt, url } = entry.event;
    if (
      typeof apiId !== "string" ||
      typeof name !== "string" ||
      typeof startAt !== "string" ||
      typeof url !== "string"
    ) {
      throw new Error("Luma event is missing api_id, name, start_at or url");
    }
  }
  return {
    entries: entries as LumaEntry[],
    has_more: hasMore === true,
    next_cursor: typeof nextCursor === "string" ? nextCursor : null,
  };
}

async function fetchPage(
  period: LumaPeriod,
  cache: LumaCache,
  cursor: string | null,
): Promise<LumaPage> {
  const params = new URLSearchParams({
    calendar_api_id: CALENDAR_API_ID,
    pagination_limit: String(PAGE_SIZE),
  });
  if (period === "past") params.set("period", "past");
  if (cursor) params.set("pagination_cursor", cursor);

  const res = await fetch(`${ENDPOINT}?${params}`, {
    headers: { accept: "application/json" },
    ...(cache === "no-store" ? { cache: "no-store" as const } : { next: cache }),
  });
  if (!res.ok) throw new Error(`Luma responded ${res.status}`);
  return parsePage(await res.json());
}

/**
 * Every page of one period, following `next_cursor` until the feed reports
 * `has_more: false`. Callers get the complete period or an exception — there
 * is no partial return.
 */
export async function fetchCalendarEntries(
  period: LumaPeriod,
  cache: LumaCache = { revalidate: REVALIDATE_SECONDS },
): Promise<LumaEntry[]> {
  const all: LumaEntry[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const { entries, has_more, next_cursor }: LumaPage = await fetchPage(period, cache, cursor);
    all.push(...entries);
    if (!has_more) return all;
    if (!next_cursor) throw new Error("Luma reported has_more without a next_cursor");
    cursor = next_cursor;
  }
  throw new Error(`Luma pagination exceeded ${MAX_PAGES} pages`);
}
