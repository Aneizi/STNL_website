"use server";

import { z } from "zod";
import { requireUser } from "../auth";
import { getSql } from "../db";
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

  await sql.transaction([update, activityStmt(user.id, `Updated event ${name}`)]);
  refreshHq();
  return { ok: true };
}
