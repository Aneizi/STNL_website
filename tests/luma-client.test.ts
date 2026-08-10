// The client is the only thing standing between a bad Luma response and the
// HQ mirror archiving real events, so its pagination and validation get tested
// directly against a stubbed fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCalendarEntries } from "@/lib/luma/client";

type Page = { entries: unknown[]; has_more?: boolean; next_cursor?: string | null };

const realFetch = globalThis.fetch;

/** Minimal well-formed entry; only the fields the client validates matter. */
function entry(apiId: string) {
  return {
    event: {
      api_id: apiId,
      name: `Event ${apiId}`,
      start_at: "2026-08-07T08:00:00.000Z",
      url: apiId,
    },
  };
}

/** Serves the given pages in order, recording the cursor each call received. */
function stubPages(pages: Page[], cursors: (string | null)[] = []) {
  let call = 0;
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    const params = new URL(String(url)).searchParams;
    cursors.push(params.get("pagination_cursor"));
    const page = pages[Math.min(call++, pages.length - 1)];
    return new Response(JSON.stringify(page), { status: 200 });
  }) as unknown as typeof fetch;
}

function stubBody(body: unknown, status = 200) {
  globalThis.fetch = vi.fn(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchCalendarEntries", () => {
  it("returns a single page when has_more is false", async () => {
    stubPages([{ entries: [entry("evt-a"), entry("evt-b")], has_more: false }]);
    const entries = await fetchCalendarEntries("past", "no-store");
    expect(entries).toHaveLength(2);
  });

  it("follows next_cursor across pages and concatenates them", async () => {
    const cursors: (string | null)[] = [];
    stubPages(
      [
        { entries: [entry("evt-a")], has_more: true, next_cursor: "cur-1" },
        { entries: [entry("evt-b")], has_more: true, next_cursor: "cur-2" },
        { entries: [entry("evt-c")], has_more: false },
      ],
      cursors,
    );

    const entries = await fetchCalendarEntries("past", "no-store");

    expect(entries.map((e) => e.event.api_id)).toEqual(["evt-a", "evt-b", "evt-c"]);
    // First request carries no cursor; each later one carries the previous.
    expect(cursors).toEqual([null, "cur-1", "cur-2"]);
  });

  it("treats an empty entries array as a legitimately empty calendar", async () => {
    stubPages([{ entries: [], has_more: false }]);
    await expect(fetchCalendarEntries("upcoming", "no-store")).resolves.toEqual([]);
  });

  it("throws rather than truncating when has_more has no cursor", async () => {
    stubPages([{ entries: [entry("evt-a")], has_more: true, next_cursor: null }]);
    await expect(fetchCalendarEntries("past", "no-store")).rejects.toThrow(/next_cursor/);
  });

  it("throws when pagination never terminates, instead of returning a short read", async () => {
    stubPages([{ entries: [entry("evt-a")], has_more: true, next_cursor: "always" }]);
    await expect(fetchCalendarEntries("past", "no-store")).rejects.toThrow(/exceeded/);
  });

  it("rejects a body with no entries array instead of reading it as empty", async () => {
    stubBody({ has_more: false });
    await expect(fetchCalendarEntries("past", "no-store")).rejects.toThrow(/entries/);
  });

  it("rejects a non-object body", async () => {
    stubBody("[]");
    await expect(fetchCalendarEntries("past", "no-store")).rejects.toThrow(/entries|non-object/);
  });

  it("rejects an entry missing the fields the mirror keys on", async () => {
    stubBody({ entries: [{ event: { name: "No api_id", start_at: "x", url: "y" } }] });
    await expect(fetchCalendarEntries("past", "no-store")).rejects.toThrow(/api_id/);
  });

  it("surfaces a non-200 response", async () => {
    stubBody({ entries: [] }, 503);
    await expect(fetchCalendarEntries("past", "no-store")).rejects.toThrow(/503/);
  });
});
