"use server";

import { z } from "zod";
import { requireUser } from "../auth";
import { getSql } from "../db";
import type { ActionResult } from "../types";
import { activityStmt, hqToday, refreshHq } from "./util";

const id = z.string().uuid();
const text = (max: number) => z.string().max(max);

async function getPartnerName(partnerId: string): Promise<string | null> {
  const sql = getSql();
  const rows = await sql`SELECT name FROM hq_partners WHERE id = ${partnerId}`;
  return rows[0]?.name ?? null;
}

const createSchema = z.object({
  name: z.string().min(1).max(200),
  channelId: id,
  captainName: text(200),
  captainContact: text(200),
  target: z.number().int().min(0).max(100000),
});

export async function createPartner(input: z.infer<typeof createSchema>): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Partner name is required." };
  const { channelId, captainName, captainContact, target } = parsed.data;
  const name = parsed.data.name.trim();
  if (!name) return { ok: false, error: "Partner name is required." };

  const sql = getSql();
  const today = await hqToday();
  // Pre-generated id keeps the insert + exchange item + activity atomic.
  const partnerId = crypto.randomUUID();
  const statements = [
    sql`
      INSERT INTO hq_partners
        (id, name, channel_id, captain_name, captain_contact, stage_id, target,
         touched_by_user_id, touched_at)
      VALUES
        (${partnerId}, ${name}, ${channelId}, ${captainName}, ${captainContact},
         (SELECT id FROM hq_partner_stages WHERE slug = 'draft'), ${target},
         ${user.id}, ${today})
    `,
    activityStmt(user.id, `Added partner ${name}`),
  ];
  await sql.transaction(statements);
  refreshHq();
  return { ok: true };
}

/** Kanban drop and the detail-page stage select share this. */
export async function setPartnerStage(
  partnerId: string,
  stageSlug: string,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(partnerId).success) return { ok: false };
  const name = await getPartnerName(partnerId);
  if (name === null) return { ok: false };

  const sql = getSql();
  const stageRows = await sql`SELECT id FROM hq_partner_stages WHERE slug = ${stageSlug}`;
  if (!stageRows[0]) return { ok: false };

  const today = await hqToday();
  await sql.transaction([
    sql`
      UPDATE hq_partners
      SET stage_id = ${stageRows[0].id}, touched_by_user_id = ${user.id}, touched_at = ${today}
      WHERE id = ${partnerId}
    `,
    activityStmt(user.id, `${name} moved to ${stageSlug}`),
  ]);
  refreshHq();
  return { ok: true };
}

const detailField = z.discriminatedUnion("field", [
  z.object({ field: z.literal("name"), value: z.string().min(1).max(200) }),
  z.object({ field: z.literal("channelId"), value: id }),
  z.object({ field: z.literal("captainName"), value: text(200) }),
  z.object({ field: z.literal("captainContact"), value: text(200) }),
  z.object({ field: z.literal("target"), value: z.number().int().min(0).max(100000) }),
]);

export async function updatePartnerDetail(
  partnerId: string,
  input: z.infer<typeof detailField>,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(partnerId).success) return { ok: false };
  const parsed = detailField.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid value." };

  const name = await getPartnerName(partnerId);
  if (name === null) return { ok: false, error: "Partner not found." };

  const sql = getSql();
  const data = parsed.data;
  let update;
  let message: string;
  switch (data.field) {
    case "name": {
      const trimmed = data.value.trim();
      if (!trimmed) return { ok: false };
      update = sql`UPDATE hq_partners SET name = ${trimmed} WHERE id = ${partnerId}`;
      message = `Renamed partner to ${trimmed}`;
      break;
    }
    case "channelId": {
      const channelRows = await sql`
        SELECT label FROM hq_partner_channels WHERE id = ${data.value}
      `;
      if (!channelRows[0]) return { ok: false };
      update = sql`UPDATE hq_partners SET channel_id = ${data.value} WHERE id = ${partnerId}`;
      message = `${name} channel set to ${channelRows[0].label}`;
      break;
    }
    case "captainName":
      update = sql`UPDATE hq_partners SET captain_name = ${data.value} WHERE id = ${partnerId}`;
      message = `Captain updated on ${name}`;
      break;
    case "captainContact":
      update = sql`UPDATE hq_partners SET captain_contact = ${data.value} WHERE id = ${partnerId}`;
      message = `Captain contact updated on ${name}`;
      break;
    case "target":
      update = sql`UPDATE hq_partners SET target = ${data.value} WHERE id = ${partnerId}`;
      message = `Target updated on ${name}`;
      break;
  }

  const today = await hqToday();
  await sql.transaction([
    update,
    sql`
      UPDATE hq_partners SET touched_by_user_id = ${user.id}, touched_at = ${today}
      WHERE id = ${partnerId}
    `,
    activityStmt(user.id, message),
  ]);
  refreshHq();
  return { ok: true };
}

export async function togglePartnerExchange(
  partnerId: string,
  itemId: string,
  done: boolean,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(partnerId).success || !id.safeParse(itemId).success) return { ok: false };
  const name = await getPartnerName(partnerId);
  if (name === null) return { ok: false };

  const sql = getSql();
  const today = await hqToday();
  const write = done
    ? sql`
        INSERT INTO hq_partner_exchange (partner_id, item_id) VALUES (${partnerId}, ${itemId})
        ON CONFLICT DO NOTHING
      `
    : sql`
        DELETE FROM hq_partner_exchange WHERE partner_id = ${partnerId} AND item_id = ${itemId}
      `;
  await sql.transaction([
    write,
    sql`
      UPDATE hq_partners SET touched_by_user_id = ${user.id}, touched_at = ${today}
      WHERE id = ${partnerId}
    `,
    activityStmt(user.id, `Exchange item updated on ${name}`),
  ]);
  refreshHq();
  return { ok: true };
}

/**
 * Cascades take the exchange checklist and contact log with the partner;
 * attributed projects keep their rows with the attribution cleared
 * (partner_id is ON DELETE SET NULL).
 */
export async function deletePartner(partnerId: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(partnerId).success) return { ok: false };
  const name = await getPartnerName(partnerId);
  if (name === null) return { ok: false, error: "Partner not found." };

  const sql = getSql();
  await sql.transaction([
    sql`DELETE FROM hq_partners WHERE id = ${partnerId}`,
    activityStmt(user.id, `Deleted partner ${name}`),
  ]);
  refreshHq();
  return { ok: true };
}

export async function addPartnerContact(partnerId: string, body: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(partnerId).success) return { ok: false };
  const parsed = z.string().min(1).max(2000).safeParse(body);
  if (!parsed.success) return { ok: false };
  const name = await getPartnerName(partnerId);
  if (name === null) return { ok: false };

  const sql = getSql();
  const today = await hqToday();
  await sql.transaction([
    sql`
      INSERT INTO hq_partner_contacts (partner_id, author_user_id, body)
      VALUES (${partnerId}, ${user.id}, ${parsed.data})
    `,
    sql`
      UPDATE hq_partners SET touched_by_user_id = ${user.id}, touched_at = ${today}
      WHERE id = ${partnerId}
    `,
    activityStmt(user.id, `Contact logged with ${name}`),
  ]);
  refreshHq();
  return { ok: true };
}
