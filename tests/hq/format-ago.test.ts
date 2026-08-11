import { describe, expect, it } from "vitest";
import { fmtAgo } from "@/lib/hq/format";

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
