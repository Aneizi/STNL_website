/**
 * Pure SQL construction for the Luma mirror. No database handle, no network,
 * no `server-only` — so tests can drive these exact statements against a
 * throwaway Postgres instead of against a copy that can drift from them.
 *
 * The orchestration that runs them lives in ./luma-sync.
 */

import type { NormalizedLumaEvent } from "@/lib/luma/normalize";
import { guessEventTypeId, type EventTypeChoice } from "./luma-event-type";

/** The tagged-template shape both drivers in lib/hq/db.ts share. */
export type Tagged = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

/**
 * The Luma-backed fields, mapping the camelCase names updateEvent() speaks to
 * the column names stored in hq_events.pinned_fields and compared against in
 * the upsert's CASE expressions. The single place those two vocabularies meet
 * — nothing else may hand-write a pin key.
 *
 * Fields absent here (typeId, attendance, spend, leads) are HQ-owned once the
 * row exists and are never written by a re-sync, so they need no pin.
 */
export const PINNABLE = {
  name: "name",
  date: "date",
  endDate: "end_date",
  venue: "venue",
  cohost: "cohost",
} as const;

export type PinnableField = keyof typeof PINNABLE;

/** The stored column name for a field, or undefined when it is HQ-owned. */
export function pinnedColumn(field: string): string | undefined {
  return (PINNABLE as Record<string, string | undefined>)[field];
}

/** The upsert's JSON payload — one object per Luma event. */
export type SyncRow = {
  luma_id: string;
  luma_url: string;
  name: string;
  date: string;
  end_date: string | null;
  venue: string;
  cohost: string;
  guest_count: number;
  type_id: string;
};

export function toSyncRow(
  ev: NormalizedLumaEvent,
  types: EventTypeChoice[],
): SyncRow | null {
  const typeId = guessEventTypeId(ev.name, ev.endDate !== null, types);
  if (!typeId) return null; // no event types configured; nothing valid to insert
  return {
    luma_id: ev.lumaId,
    luma_url: ev.url,
    name: ev.name,
    date: ev.date,
    end_date: ev.endDate,
    // hq_events.venue and .cohost are NOT NULL DEFAULT ''
    venue: ev.venue ?? "",
    cohost: ev.cohosts.join(", "),
    guest_count: ev.guestCount,
    type_id: typeId,
  };
}

/**
 * The transaction body, as statements the caller runs in order.
 *
 * Exported so tests can drive the real SQL against a throwaway Postgres rather
 * than against a copy of it that can drift.
 *
 * `reconcile: false` omits the archive statement entirely — used when Luma
 * returned no events at all, where `luma_id <> ALL('{}')` is true for every
 * row and would archive the whole calendar in one shot.
 */
export function buildSyncStatements(
  sql: Tagged,
  input: { rows: SyncRow[]; ids: string[]; startedAt: string; reconcile: boolean },
): unknown[] {
  const { rows, ids, startedAt, reconcile } = input;

  // Concurrent syncs block here until the first commits, at which point the
  // loser's guards below all fail and its writes become no-ops.
  const lock = sql`SELECT 1 FROM hq_luma_sync WHERE id = true FOR UPDATE`;

  const upsert = sql`
    WITH src AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(
        luma_id text, luma_url text, name text, date date, end_date date,
        venue text, cohost text, guest_count int, type_id uuid
      )
    )
    INSERT INTO hq_events (
      luma_id, luma_url, name, date, end_date, venue, cohost,
      attendance, type_id, spend, leads
    )
    SELECT s.luma_id, s.luma_url, s.name, s.date, s.end_date, s.venue, s.cohost,
           s.guest_count, s.type_id, 0, 0
    FROM src s
    WHERE (SELECT last_success_at FROM hq_luma_sync) <= ${startedAt}::timestamptz
    ON CONFLICT (luma_id) DO UPDATE SET
      luma_url = EXCLUDED.luma_url,
      name     = CASE WHEN 'name'     = ANY(hq_events.pinned_fields)
                      THEN hq_events.name     ELSE EXCLUDED.name     END,
      date     = CASE WHEN 'date'     = ANY(hq_events.pinned_fields)
                      THEN hq_events.date     ELSE EXCLUDED.date     END,
      end_date = CASE WHEN 'end_date' = ANY(hq_events.pinned_fields)
                      THEN hq_events.end_date ELSE EXCLUDED.end_date END,
      venue    = CASE WHEN 'venue'    = ANY(hq_events.pinned_fields)
                      THEN hq_events.venue    ELSE EXCLUDED.venue    END,
      cohost   = CASE WHEN 'cohost'   = ANY(hq_events.pinned_fields)
                      THEN hq_events.cohost   ELSE EXCLUDED.cohost   END,
      -- An auto-archived event that reappears in Luma comes back; one archived
      -- by hand stays archived, or it would un-archive itself on every sync.
      archived_at     = CASE WHEN hq_events.archived_reason = 'missing'
                             THEN NULL ELSE hq_events.archived_at END,
      archived_reason = CASE WHEN hq_events.archived_reason = 'missing'
                             THEN NULL ELSE hq_events.archived_reason END
  `;
  // attendance, type_id, spend and leads appear only in the INSERT column list
  // above — never in DO UPDATE. They are HQ-owned once the row exists.

  const archive = sql`
    UPDATE hq_events SET archived_at = now(), archived_reason = 'missing'
    WHERE luma_id IS NOT NULL
      AND luma_id <> ALL(${ids}::text[])
      AND archived_at IS NULL
      AND (SELECT last_success_at FROM hq_luma_sync) <= ${startedAt}::timestamptz
    RETURNING id
  `;

  const stamp = sql`
    UPDATE hq_luma_sync SET last_success_at = now()
    WHERE last_success_at <= ${startedAt}::timestamptz
  `;

  return reconcile ? [lock, upsert, archive, stamp] : [lock, upsert, stamp];
}
