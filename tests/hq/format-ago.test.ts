import { describe, expect, it } from "vitest";
import { fmtAgo, fmtWithZone } from "@/lib/hq/format";

const NOW = Date.parse("2026-08-11T12:00:00Z");
const ago = (ms: number) => fmtAgo(new Date(NOW - ms).toISOString(), NOW);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("fmtAgo", () => {
  it("labels each magnitude", () => {
    expect(ago(20_000)).toBe("just now");
    expect(ago(MINUTE)).toBe("1m ago");
    expect(ago(59 * MINUTE)).toBe("59m ago");
    expect(ago(HOUR)).toBe("1h ago");
    expect(ago(47 * HOUR)).toBe("47h ago");
    expect(ago(48 * HOUR)).toBe("2d ago");
    expect(ago(9 * 24 * HOUR)).toBe("9d ago");
  });

  it("never reports the future as elapsed", () => {
    // Clock skew between the database and the renderer must not print "-3m".
    expect(fmtAgo(new Date(NOW + HOUR).toISOString(), NOW)).toBe("just now");
  });
});

describe("fmtWithZone", () => {
  it("spells out the IANA zone name beside the local time, for a fixed instant in two different zones", () => {
    // 2026-09-14T16:32:00Z is 18:32 in Amsterdam (CEST, UTC+2 under DST).
    expect(fmtWithZone("2026-09-14T16:32:00Z", "Europe/Amsterdam")).toBe("14 Sept 2026, 18:32 Europe/Amsterdam");
    // 2026-01-05T05:15:00Z is 00:15 in New York (EST, UTC-5, no DST in January).
    expect(fmtWithZone("2026-01-05T05:15:00Z", "America/New_York")).toBe("5 Jan 2026, 00:15 America/New_York");
  });

  it("returns empty for no value or an unparseable one, never a garbled string", () => {
    expect(fmtWithZone("", "Europe/Amsterdam")).toBe("");
    expect(fmtWithZone("not-a-date", "Europe/Amsterdam")).toBe("");
  });
});
