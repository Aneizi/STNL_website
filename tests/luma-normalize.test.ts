// Normalization is the shared contract between the public ledger and the HQ
// mirror, so both pages inherit whatever these get wrong. Fixtures follow the
// shapes returned by api.lu.ma for luma.com/stnl.
import { describe, expect, it } from "vitest";
import { guessEventTypeId } from "@/lib/hq/luma-event-type";
import type { LumaEntry } from "@/lib/luma/client";
import { toLumaEvent } from "@/lib/luma/normalize";

function entry(over: Partial<LumaEntry["event"]> = {}, rest: Partial<LumaEntry> = {}): LumaEntry {
  return {
    event: {
      api_id: "evt-a",
      name: "Superteam NL Co-Working Friday",
      start_at: "2026-08-07T08:00:00.000Z",
      end_at: "2026-08-07T15:00:00.000Z",
      timezone: "Europe/Amsterdam",
      url: "rtmof6rp",
      location_type: "offline",
      geo_address_info: { city: "Amsterdam", address: "AI AM" },
      ...over,
    },
    ...rest,
  };
}

describe("toLumaEvent", () => {
  it("derives the calendar day in the event's own timezone", () => {
    // 23:30 UTC is already the next day in Amsterdam (UTC+2 in August).
    const ev = toLumaEvent(entry({ start_at: "2026-08-07T23:30:00.000Z", end_at: null }));
    expect(ev.date).toBe("2026-08-08");
  });

  it("leaves endDate null when the event starts and ends on one day", () => {
    const ev = toLumaEvent(entry());
    expect(ev.endDate).toBeNull();
    expect(ev.days).toBe(1);
  });

  it("spans multiple days inclusively", () => {
    const ev = toLumaEvent(
      entry({ start_at: "2026-08-31T08:00:00.000Z", end_at: "2026-09-05T15:00:00.000Z" }),
    );
    expect(ev.endDate).toBe("2026-09-05");
    expect(ev.days).toBe(6);
  });

  it("ignores an end that is not after the start", () => {
    const ev = toLumaEvent(
      entry({ start_at: "2026-08-07T08:00:00.000Z", end_at: "2026-08-07T08:00:00.000Z" }),
    );
    expect(ev.endDate).toBeNull();
  });

  it("drops a URL-only address, which is not a venue", () => {
    const ev = toLumaEvent(entry({ geo_address_info: { city: "Amsterdam", address: "https://meet.example" } }));
    expect(ev.venue).toBeNull();
  });

  it("returns null rather than an empty venue when Luma hides the address", () => {
    expect(toLumaEvent(entry({ geo_address_info: null })).venue).toBeNull();
  });

  it("reports online events as Online", () => {
    expect(toLumaEvent(entry({ location_type: "virtual" })).city).toBe("Online");
  });

  it("lists cohosts but not our own calendar", () => {
    const ev = toLumaEvent(
      entry({}, { hosts: [{ name: "Superteam NL" }, { name: "Nosana" }, { name: "SBAN" }] }),
    );
    expect(ev.cohosts).toEqual(["Nosana", "SBAN"]);
  });

  it("has no cohosts when we are the only host", () => {
    expect(toLumaEvent(entry({}, { hosts: [{ name: "Superteam NL" }] })).cohosts).toEqual([]);
  });

  it("detects the featured tag by name or slug", () => {
    expect(toLumaEvent(entry({}, { tags: [{ name: "Featured" }] })).featured).toBe(true);
    expect(toLumaEvent(entry({}, { tags: ["Hackathon"] })).featured).toBe(false);
  });

  it("defaults a missing guest count to zero", () => {
    expect(toLumaEvent(entry()).guestCount).toBe(0);
    expect(toLumaEvent(entry({}, { guest_count: 189 })).guestCount).toBe(189);
  });

  it("builds the public event URL from the slug", () => {
    expect(toLumaEvent(entry()).url).toBe("https://luma.com/rtmof6rp");
  });
});

describe("guessEventTypeId", () => {
  const types = [
    { id: "multi", label: "Multi-day program" },
    { id: "cowork", label: "Weekly coworking" },
    { id: "workshop", label: "Workshop" },
    { id: "pitch", label: "Pitch session" },
    { id: "demo", label: "Demo day" },
    { id: "mixer", label: "Community mixer" },
    { id: "other", label: "Other" },
  ];

  it("prefers the multi-day type for a span, whatever the title says", () => {
    expect(guessEventTypeId("Workshop Week", true, types)).toBe("multi");
  });

  it.each([
    ["Superteam NL Co-Working Friday @ AI AM", "cowork"],
    ["Amsterdam coworking session", "cowork"],
    ["DBW 2026 - Solana Demo Day", "demo"],
    ["Superteam NL x Goatfish Workshop", "workshop"],
    ["Pizza + Pitches with EasyA", "pitch"],
    ["Community Mixer", "mixer"],
  ])("matches %s to the right type", (name, expected) => {
    expect(guessEventTypeId(name, false, types)).toBe(expected);
  });

  it("falls back to Other when nothing matches", () => {
    expect(guessEventTypeId("Touch the Grass Event", false, types)).toBe("other");
  });

  it("falls back to the first type when the database has no Other", () => {
    const withoutOther = types.filter((t) => t.label !== "Other");
    expect(guessEventTypeId("Touch the Grass Event", false, withoutOther)).toBe("multi");
  });

  it("returns null when no types exist at all", () => {
    expect(guessEventTypeId("Anything", false, [])).toBeNull();
  });
});
