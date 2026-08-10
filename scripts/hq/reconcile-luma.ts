// One-time reconciliation of hand-entered HQ events against the Luma calendar.
//
// Adding a nullable luma_id silently reclassifies every existing hq_events row
// as "external". The first sync would then insert a second, Luma-backed row
// for events already tracked by hand — duplicating exactly what the mirror
// exists to remove, and stranding the budget and leads on the orphaned copy.
//
// This adopts the obvious matches: same normalized name, same date, exactly
// one candidate. Anything ambiguous is printed for a human rather than
// guessed at, and nothing is written without --apply. It is a script and not
// a step in the sync path on purpose — matching production rows on a name
// heuristic is irreversible, and irreversible heuristics do not belong in a
// page load.
//
// Usage:  npm run hq:reconcile-luma          (dry run — reports only)
//         npm run hq:reconcile-luma -- --apply
import { createSql } from "../../lib/hq/db";
import { normName } from "../../lib/hq/format";
import { fetchCalendarEntries } from "../../lib/luma/client";
import { toLumaEvent, type NormalizedLumaEvent } from "../../lib/luma/normalize";
import { loadEnvLocal, requireEnv } from "./env";

type HqRow = { id: string; name: string; date: string };

type Match = { row: HqRow; luma: NormalizedLumaEvent };

function key(name: string, date: string): string {
  return `${normName(name)}@${date}`;
}

async function main() {
  const apply = process.argv.includes("--apply");
  loadEnvLocal();
  const sql = createSql(requireEnv("DATABASE_URL_UNPOOLED"));

  // Both periods, fully paginated — a short read would look like "no match"
  // and leave rows unadopted, which is the failure this script exists to stop.
  const [upcoming, past] = await Promise.all([
    fetchCalendarEntries("upcoming", "no-store"),
    fetchCalendarEntries("past", "no-store"),
  ]);
  const lumaEvents = [...past, ...upcoming].map(toLumaEvent);

  const candidates = new Map<string, NormalizedLumaEvent[]>();
  for (const ev of lumaEvents) {
    const k = key(ev.name, ev.date);
    candidates.set(k, [...(candidates.get(k) ?? []), ev]);
  }

  const rows = (await sql.query(
    `SELECT id, name, date::text AS date FROM hq_events WHERE luma_id IS NULL ORDER BY date`,
  )) as unknown as HqRow[];

  const adopt: Match[] = [];
  const ambiguous: Array<{ row: HqRow; count: number }> = [];
  const unmatched: HqRow[] = [];

  // A Luma event already mirrored under one row must not be adopted by a
  // second one; the unique index would reject it, and the first claim wins.
  const claimed = new Set<string>();

  for (const row of rows) {
    const found = (candidates.get(key(row.name, row.date)) ?? []).filter(
      (ev) => !claimed.has(ev.lumaId),
    );
    if (found.length === 1) {
      claimed.add(found[0].lumaId);
      adopt.push({ row, luma: found[0] });
    } else if (found.length > 1) {
      ambiguous.push({ row, count: found.length });
    } else {
      unmatched.push(row);
    }
  }

  console.log(`Hand-entered events: ${rows.length}`);
  console.log(`Luma events fetched: ${lumaEvents.length}\n`);

  console.log(`Unique matches (${adopt.length}):`);
  for (const { row, luma } of adopt) {
    console.log(`  ${row.date}  ${row.name}  ->  ${luma.lumaId}`);
  }

  if (ambiguous.length > 0) {
    console.log(`\nAmbiguous, left alone (${ambiguous.length}) — resolve by hand:`);
    for (const { row, count } of ambiguous) {
      console.log(`  ${row.date}  ${row.name}  (${count} Luma events share this name and date)`);
    }
  }

  if (unmatched.length > 0) {
    console.log(`\nNo Luma match, staying external (${unmatched.length}):`);
    for (const row of unmatched) console.log(`  ${row.date}  ${row.name}`);
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to adopt the unique matches.");
    return;
  }

  for (const { row, luma } of adopt) {
    await sql.query(`UPDATE hq_events SET luma_id = $1, luma_url = $2 WHERE id = $3`, [
      luma.lumaId,
      luma.url,
      row.id,
    ]);
  }
  console.log(`\nAdopted ${adopt.length} events.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
