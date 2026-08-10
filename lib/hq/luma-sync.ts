import "server-only";

import { fetchCalendarEntries } from "@/lib/luma/client";
import { toLumaEvent, type NormalizedLumaEvent } from "@/lib/luma/normalize";
import { getSql } from "./db";
import type { EventTypeChoice } from "./luma-event-type";
import { buildSyncStatements, toSyncRow, type SyncRow, type Tagged } from "./luma-sync-sql";

/**
 * Mirrors the public Luma calendar into hq_events.
 *
 * Two properties matter more than anything else here:
 *
 *  - **Absence archives.** An event missing from the response is archived, so
 *    a truncated or failed read must never be mistaken for a complete one.
 *    Both periods have to paginate to completion before anything is written.
 *  - **Nothing is written twice.** Concurrent syncs serialise on a row lock,
 *    and every write is guarded by a timestamp comparison, so the loser of the
 *    race no-ops instead of replaying stale data over fresh data.
 *
 * lib/hq/db.ts exposes a *non-interactive* transaction — an array of
 * pre-built statements with no chance to branch between them — which is why
 * the guard is an SQL predicate on each statement rather than an early return,
 * and why the upsert is one multi-row statement fed a single JSON parameter.
 */

const FRESH_FOR_MS = 5 * 60 * 1000;

export type SyncResult =
  | { ok: true; skipped: true }
  | { ok: true; skipped: false; seen: number; archived: number; reconciled: boolean }
  | { ok: false; error: string };

async function fetchAll(): Promise<NormalizedLumaEvent[]> {
  // Both periods must succeed; Promise.all rejects on the first failure, which
  // is the intent — a half-read calendar must not reach the database.
  const [upcoming, past] = await Promise.all([
    fetchCalendarEntries("upcoming", "no-store"),
    fetchCalendarEntries("past", "no-store"),
  ]);
  const byId = new Map<string, NormalizedLumaEvent>();
  // An event can legitimately appear in both feeds around its start time.
  for (const entry of [...past, ...upcoming]) {
    const ev = toLumaEvent(entry);
    byId.set(ev.lumaId, ev);
  }
  return [...byId.values()];
}

/**
 * Never throws. The events page calls this before reading the mirror, and a
 * sync problem — an unreachable Luma, a database that has not been migrated
 * yet — must not take the page down with it: the already-mirrored rows are
 * still worth serving. Callers that want to show the failure read the result;
 * the page ignores it, and the Sync button surfaces it.
 */
export async function syncLumaEvents(
  options: { force?: boolean } = {},
): Promise<SyncResult> {
  try {
    return await runSync(options);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Luma sync failed" };
  }
}

async function runSync({ force = false }: { force?: boolean }): Promise<SyncResult> {
  const sql = getSql();

  // Advisory only: skips a pointless round trip to Luma. Correctness comes
  // from the lock and the guards, not from this check.
  if (!force) {
    const [state] = await sql`SELECT last_success_at FROM hq_luma_sync WHERE id = true`;
    const last = state ? Date.parse(String(state.last_success_at)) : 0;
    if (Number.isFinite(last) && Date.now() - last < FRESH_FOR_MS) {
      return { ok: true, skipped: true };
    }
  }

  // Captured before the network call: any sync that commits while we are
  // fetching makes our data stale, and the guards will then drop our writes.
  const startedAt = new Date().toISOString();

  // A failure here propagates to syncLumaEvents' catch with nothing written and
  // last_success_at untouched, so the next request retries immediately rather
  // than waiting out a burnt window.
  const [events, typeRows] = await Promise.all([
    fetchAll(),
    sql`SELECT id, label FROM hq_event_types ORDER BY sort`,
  ]);
  const types: EventTypeChoice[] = typeRows.map((r) => ({
    id: String(r.id),
    label: String(r.label),
  }));

  const rows = events.map((ev) => toSyncRow(ev, types)).filter((r): r is SyncRow => r !== null);
  const ids = rows.map((r) => r.luma_id);

  // Every event vanishing at once is far more likely to be an upstream shape
  // change than a genuinely emptied calendar, so decline to archive the lot.
  const reconcile = ids.length > 0;

  const statements = buildSyncStatements(sql as unknown as Tagged, {
    rows,
    ids,
    startedAt,
    reconcile,
  });
  // Should this throw, the transaction rolled back and last_success_at never
  // advanced, so the mirror is exactly as it was before the attempt.
  const results = (await sql.transaction(
    statements as Parameters<typeof sql.transaction>[0],
  )) as unknown[][];

  return {
    ok: true,
    skipped: false,
    seen: rows.length,
    archived: reconcile ? results[2].length : 0,
    reconciled: reconcile,
  };
}
