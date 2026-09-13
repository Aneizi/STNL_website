"use server";

import { z } from "zod";
import { requireUser } from "../auth";
import { builderDatabase } from "../builder-db";
import { BuilderError } from "../builder-types";
import { correctPersonMatch as correctPersonMatchRecord } from "../crm-identity";
import { getSql } from "../db";
import { requireHackathon } from "../hackathon";
import type { ActionResult } from "../types";
import { activityStmt, inHackathon, refreshHq } from "./util";

const id = z.string().uuid();
const text = (max: number) => z.string().max(max);

const createSchema = z.object({
  name: z.string().min(1).max(200),
  roleId: id,
  org: text(200),
  contact: text(200),
  partnerId: id.nullable(),
  notes: text(1000),
});

export async function createPerson(input: z.infer<typeof createSchema>): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Name is required." };
  const { roleId, org, contact, partnerId, notes } = parsed.data;
  const name = parsed.data.name.trim();
  if (!name) return { ok: false, error: "Name is required." };

  const sql = getSql();
  // A partner from another hackathon cannot be attached; the subselect yields
  // NULL for it, so the person is still created, just unattributed.
  await sql.transaction([
    sql`
      INSERT INTO hq_people (hackathon_id, name, role_id, org, contact, partner_id, notes)
      VALUES (${hackathon.id}, ${name}, ${roleId}, ${org}, ${contact},
        (SELECT id FROM hq_partners
         WHERE id = ${partnerId}::uuid AND hackathon_id = ${hackathon.id}),
        ${notes})
    `,
    activityStmt(user.id, hackathon.id, `Added ${name} to people`),
  ]);
  refreshHq();
  return { ok: true };
}

const personField = z.discriminatedUnion("field", [
  z.object({ field: z.literal("name"), value: z.string().min(1).max(200) }),
  z.object({ field: z.literal("roleId"), value: id }),
  z.object({ field: z.literal("org"), value: text(200) }),
  z.object({ field: z.literal("contact"), value: text(200) }),
  z.object({ field: z.literal("partnerId"), value: id.nullable() }),
  z.object({ field: z.literal("notes"), value: text(1000) }),
]);

export async function updatePerson(
  personId: string,
  input: z.infer<typeof personField>,
): Promise<ActionResult> {
  const user = await requireUser();
  const selected = await requireHackathon();
  if (!id.safeParse(personId).success) return { ok: false };
  const parsed = personField.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid value." };

  const sql = getSql();
  const rows = await sql`SELECT name, hackathon_id FROM hq_people WHERE id = ${personId}`;
  // A card from another edition than the selected one is not found, exactly
  // like a missing card: neither a swapped cookie nor a crafted id reaches it.
  const person = inHackathon(rows[0] ? { name: String(rows[0].name), hackathonId: Number(rows[0].hackathon_id) } : null, selected.id);
  if (!person) return { ok: false, error: "Person not found." };
  const { name, hackathonId } = person;

  const data = parsed.data;
  let update;
  switch (data.field) {
    case "name": {
      const trimmed = data.value.trim();
      if (!trimmed) return { ok: false };
      update = sql`UPDATE hq_people SET name = ${trimmed} WHERE id = ${personId}`;
      break;
    }
    case "roleId":
      update = sql`UPDATE hq_people SET role_id = ${data.value} WHERE id = ${personId}`;
      break;
    case "org":
      update = sql`UPDATE hq_people SET org = ${data.value} WHERE id = ${personId}`;
      break;
    case "contact":
      update = sql`UPDATE hq_people SET contact = ${data.value} WHERE id = ${personId}`;
      break;
    case "partnerId":
      // Only a partner of the same hackathon can be attached.
      update = sql`
        UPDATE hq_people
        SET partner_id = (SELECT id FROM hq_partners
                          WHERE id = ${data.value}::uuid AND hackathon_id = ${hackathonId})
        WHERE id = ${personId}
      `;
      break;
    case "notes":
      update = sql`UPDATE hq_people SET notes = ${data.value} WHERE id = ${personId}`;
      break;
  }

  await sql.transaction([update, activityStmt(user.id, hackathonId, `Updated ${name}`)]);
  refreshHq();
  return { ok: true };
}

const correctionSchema = z.object({
  personId: id,
  toUserId: z.string().min(1).max(200).nullable(),
  reason: z.string().trim().min(3).max(500),
});

/**
 * The explicit correction of a provisional person match: this CRM person is
 * really the account `toUserId`, or (`null`) is not the account it is linked
 * to. Never inferred from a display name. Re-points or clears the person's
 * account link and its People cards, merges into the account's own person
 * when it already has one, and records `person.match_corrected`, all in one
 * transaction (lib/hq/crm-identity.ts). No roles, tags, tiers or grants are
 * touched.
 */
export async function correctPersonMatch(input: z.infer<typeof correctionSchema>): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = correctionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Give a reason of at least 3 characters." };
  try {
    const result = await correctPersonMatchRecord(builderDatabase(), { ...parsed.data, actor: { kind: "operator", id: user.id } });
    if (!result.changed) return { ok: false, error: "This person already has that link. Nothing to correct." };
  } catch (error) {
    if (error instanceof BuilderError) return { ok: false, error: error.message };
    throw error;
  }
  refreshHq();
  return { ok: true };
}
