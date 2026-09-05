// Pure helpers for hackathon records, shared by server code, client screens
// and tests. No database, no request context.

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

/**
 * The span printed under a hackathon's name. Full month names, the year said
 * once unless the span crosses into another: "September 14 – October 12, 2026",
 * "March 3 – 9, 2026", "December 1, 2026 – January 15, 2027". A single-day
 * hackathon reads "March 3, 2026".
 */
export function fmtDateRange(startIso: string, endIso: string): string {
  if (!startIso || !endIso) return "";
  const a = parts(startIso);
  const b = parts(endIso);
  const month = (n: number) => MONTHS[n - 1] ?? "";
  if (a.y !== b.y) {
    return `${month(a.m)} ${a.d}, ${a.y} – ${month(b.m)} ${b.d}, ${b.y}`;
  }
  if (a.m !== b.m) return `${month(a.m)} ${a.d} – ${month(b.m)} ${b.d}, ${a.y}`;
  if (a.d !== b.d) return `${month(a.m)} ${a.d} – ${b.d}, ${a.y}`;
  return `${month(a.m)} ${a.d}, ${a.y}`;
}

/**
 * URL-safe key derived from a name: lower-case ASCII words joined by hyphens.
 * "Colosseum World's Fair" → "colosseum-worlds-fair". Empty when nothing
 * survives, so the caller can fall back to something else.
 */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Whether the hackathon is running today ("YYYY-MM-DD" strings compare as dates). */
export function isLive(h: { startDate: string; endDate: string }, todayIso: string): boolean {
  return h.startDate <= todayIso && todayIso <= h.endDate;
}
