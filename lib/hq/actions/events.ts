"use server";

import { z } from "zod";
import { requireUser } from "../auth";
import { getSql } from "../db";
import { syncLumaEvents } from "../luma-sync";
import { pinnedColumn, type PinnableField } from "../luma-sync-sql";
import type { ActionResult } from "../types";
import { activityStmt, refreshHq } from "./util";

const id = z.string().uuid();
const text = (max: number) => z.string().max(max);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const createSchema = z.object({
  name: z.string().min(1).max(200),
  date: isoDate,
  endDate: isoDate.nullable(),
  typeId: id,
  venue: text(200),
  cohost: text(200),
  spend: z.number().int().min(0).max(10_000_000),
});

export async function createEvent(input: z.infer<typeof createSchema>): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Event name and date are required." };
  const { date, endDate, typeId, venue, cohost, spend } = parsed.data;
  const name = parsed.data.name.trim();
  if (!name) return { ok: false, error: "Event name and date are required." };

  const sql = getSql();
  await sql.transaction([
    sql`
      INSERT INTO hq_events (name, date, end_date, type_id, venue, cohost, spend)
      VALUES (${name}, ${date}, ${endDate}, ${typeId}, ${venue}, ${cohost}, ${spend})
    `,
    activityStmt(user.id, `Added event ${name}`),
  ]);
  refreshHq();
  return { ok: true };
}

// Attendance and leads are editable here even though the original mock's
// numbers only came from seed data — a clean-start database needs a write
// path for them (user-approved deviation).
const eventField = z.discriminatedUnion("field", [
  z.object({ field: z.literal("name"), value: z.string().min(1).max(200) }),
  z.object({ field: z.literal("date"), value: isoDate }),
  z.object({ field: z.literal("endDate"), value: isoDate.nullable() }),
  z.object({ field: z.literal("typeId"), value: id }),
  z.object({ field: z.literal("venue"), value: text(200) }),
  z.object({ field: z.literal("cohost"), value: text(200) }),
  z.object({ field: z.literal("spend"), value: z.number().int().min(0).max(10_000_000) }),
  z.object({ field: z.literal("attendance"), value: z.number().int().min(0).max(1_000_000) }),
  z.object({ field: z.literal("leads"), value: z.number().int().min(0).max(1_000_000) }),
]);

export async function updateEvent(
  eventId: string,
  input: z.infer<typeof eventField>,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(eventId).success) return { ok: false };
  const parsed = eventField.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid value." };

  const sql = getSql();
  const rows = await sql`SELECT name FROM hq_events WHERE id = ${eventId}`;
  if (!rows[0]) return { ok: false, error: "Event not found." };
  const name = rows[0].name as string;

  const data = parsed.data;
  let update;
  switch (data.field) {
    case "name": {
      const trimmed = data.value.trim();
      if (!trimmed) return { ok: false };
      update = sql`UPDATE hq_events SET name = ${trimmed} WHERE id = ${eventId}`;
      break;
    }
    case "date":
      update = sql`UPDATE hq_events SET date = ${data.value} WHERE id = ${eventId}`;
      break;
    case "endDate":
      update = sql`UPDATE hq_events SET end_date = ${data.value} WHERE id = ${eventId}`;
      break;
    case "typeId":
      update = sql`UPDATE hq_events SET type_id = ${data.value} WHERE id = ${eventId}`;
      break;
    case "venue":
      update = sql`UPDATE hq_events SET venue = ${data.value} WHERE id = ${eventId}`;
      break;
    case "cohost":
      update = sql`UPDATE hq_events SET cohost = ${data.value} WHERE id = ${eventId}`;
      break;
    case "spend":
      update = sql`UPDATE hq_events SET spend = ${data.value} WHERE id = ${eventId}`;
      break;
    case "attendance":
      update = sql`UPDATE hq_events SET attendance = ${data.value} WHERE id = ${eventId}`;
      break;
    case "leads":
      update = sql`UPDATE hq_events SET leads = ${data.value} WHERE id = ${eventId}`;
      break;
  }

  // Editing a Luma-backed field pins it, so later syncs stop overwriting it.
  // The statement guards itself on luma_id, so external events are unaffected
  // and no branch is needed here.
  const column = pinnedColumn(data.field);
  const statements = [update, activityStmt(user.id, `Updated event ${name}`)];
  if (column) {
    statements.unshift(sql`
      UPDATE hq_events SET pinned_fields = array_append(pinned_fields, ${column})
      WHERE id = ${eventId} AND luma_id IS NOT NULL
        AND NOT (${column} = ANY(pinned_fields))
    `);
  }

  await sql.transaction(statements);
  refreshHq();
  return { ok: true };
}

/**
 * Releases a pinned field back to Luma's control; the next sync restores its
 * value.
 */
export async function unpinEventField(
  eventId: string,
  field: PinnableField,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(eventId).success) return { ok: false };
  const column = pinnedColumn(field);
  if (!column) return { ok: false, error: "That field is not synced from Luma." };

  const sql = getSql();
  const rows = await sql`SELECT name FROM hq_events WHERE id = ${eventId}`;
  if (!rows[0]) return { ok: false, error: "Event not found." };

  await sql.transaction([
    sql`
      UPDATE hq_events SET pinned_fields = array_remove(pinned_fields, ${column})
      WHERE id = ${eventId}
    `,
    activityStmt(user.id, `Reset ${field} to Luma for ${rows[0].name as string}`),
  ]);
  refreshHq();
  return { ok: true };
}

/**
 * Archiving is the only way to retire a Luma event: the row may carry HQ
 * metrics and project attributions that a delete would take with it. The
 * 'manual' reason is what stops the next sync from un-archiving it.
 */
export async function archiveEvent(eventId: string): Promise<ActionResult> {
  const user = await requireUser();
  return setArchived(user.id, eventId, true);
}

export async function unarchiveEvent(eventId: string): Promise<ActionResult> {
  const user = await requireUser();
  return setArchived(user.id, eventId, false);
}

/** Shared body; both callers authenticate before reaching it. */
async function setArchived(
  userId: string,
  eventId: string,
  archived: boolean,
): Promise<ActionResult> {
  if (!id.safeParse(eventId).success) return { ok: false };

  const sql = getSql();
  const rows = await sql`SELECT name FROM hq_events WHERE id = ${eventId}`;
  if (!rows[0]) return { ok: false, error: "Event not found." };
  const name = rows[0].name as string;

  await sql.transaction([
    archived
      ? sql`
          UPDATE hq_events SET archived_at = now(), archived_reason = 'manual'
          WHERE id = ${eventId}
        `
      : sql`
          UPDATE hq_events SET archived_at = NULL, archived_reason = NULL
          WHERE id = ${eventId}
        `,
    activityStmt(userId, `${archived ? "Archived" : "Unarchived"} event ${name}`),
  ]);
  refreshHq();
  return { ok: true };
}

/**
 * Only external events can be deleted. A Luma-sourced row would reappear on
 * the next sync anyway, minus whatever HQ had recorded against it.
 */
export async function deleteEvent(eventId: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(eventId).success) return { ok: false };

  const sql = getSql();
  const rows = await sql`SELECT name, luma_id FROM hq_events WHERE id = ${eventId}`;
  if (!rows[0]) return { ok: false, error: "Event not found." };
  if (rows[0].luma_id) {
    return { ok: false, error: "Luma events can be archived, not deleted." };
  }
  const name = rows[0].name as string;

  await sql.transaction([
    // The luma_id guard is repeated in SQL so the rule holds even if the row
    // became Luma-backed between the check above and this delete.
    sql`DELETE FROM hq_events WHERE id = ${eventId} AND luma_id IS NULL`,
    activityStmt(user.id, `Deleted event ${name}`),
  ]);
  refreshHq();
  return { ok: true };
}

/**
 * The Sync button's entry point. components/hq/events.tsx is a client
 * component and cannot reach lib/hq/luma-sync directly, so this authenticated
 * action is the only exposed path to it.
 */
export async function syncLuma(): Promise<ActionResult> {
  await requireUser();
  const result = await syncLumaEvents({ force: true });
  if (!result.ok) return { ok: false, error: `Luma sync failed: ${result.error}` };
  refreshHq();
  return { ok: true };
}
