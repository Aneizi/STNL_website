import { describe, expect, it } from "vitest";
import { fmtDateRange, isLive, slugify } from "@/lib/hq/hackathon-format";

describe("fmtDateRange", () => {
  it("names the year once when both dates share it", () => {
    expect(fmtDateRange("2026-09-14", "2026-10-12")).toBe("September 14 – October 12, 2026");
  });

  it("collapses a span inside one month", () => {
    expect(fmtDateRange("2026-03-03", "2026-03-09")).toBe("March 3 – 9, 2026");
  });

  it("spells both years when the span crosses one", () => {
    expect(fmtDateRange("2026-12-01", "2027-01-15")).toBe("December 1, 2026 – January 15, 2027");
  });

  it("reads as one date for a single day", () => {
    expect(fmtDateRange("2026-03-03", "2026-03-03")).toBe("March 3, 2026");
  });

  it("is empty when either date is missing", () => {
    expect(fmtDateRange("", "2026-03-03")).toBe("");
  });
});

describe("slugify", () => {
  it("drops apostrophes and joins words with hyphens", () => {
    expect(slugify("Colosseum World's Fair")).toBe("colosseum-worlds-fair");
  });

  it("strips accents and punctuation", () => {
    expect(slugify("  Été — Hackathon #3!  ")).toBe("ete-hackathon-3");
  });

  it("is empty when nothing survives", () => {
    expect(slugify("’’")).toBe("");
  });
});

describe("isLive", () => {
  const h = { startDate: "2026-09-14", endDate: "2026-10-12" };
  it("is true on the first and last day", () => {
    expect(isLive(h, "2026-09-14")).toBe(true);
    expect(isLive(h, "2026-10-12")).toBe(true);
  });
  it("is false either side", () => {
    expect(isLive(h, "2026-09-13")).toBe(false);
    expect(isLive(h, "2026-10-13")).toBe(false);
  });
});
