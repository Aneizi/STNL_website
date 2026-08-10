"use server";

import { z } from "zod";
import { requireUser } from "../auth";
import { getSql } from "../db";
import type { ActionResult } from "../types";
import { activityStmt, refreshHq } from "./util";

const id = z.string().uuid();
const text = (max: number) => z.string().max(max);

const createSchema = z.object({
  name: z.string().min(1).max(200),
  roleId: id,
  org: text(200),
  contact: text(200),
  partnerId: id.nullable(),
});

export async function createPerson(input: z.infer<typeof createSchema>): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Name is required." };
  const { roleId, org, contact, partnerId } = parsed.data;
  const name = parsed.data.name.trim();
  if (!name) return { ok: false, error: "Name is required." };

  const sql = getSql();
  await sql.transaction([
    sql`
      INSERT INTO hq_people (name, role_id, org, contact, partner_id)
      VALUES (${name}, ${roleId}, ${org}, ${contact}, ${partnerId})
    `,
    activityStmt(user.id, `Added ${name} to people`),
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
  if (!id.safeParse(personId).success) return { ok: false };
  const parsed = personField.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid value." };

  const sql = getSql();
  const rows = await sql`SELECT name FROM hq_people WHERE id = ${personId}`;
  if (!rows[0]) return { ok: false, error: "Person not found." };
  const name = rows[0].name as string;

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
      update = sql`UPDATE hq_people SET partner_id = ${data.value} WHERE id = ${personId}`;
      break;
    case "notes":
      update = sql`UPDATE hq_people SET notes = ${data.value} WHERE id = ${personId}`;
      break;
  }

  await sql.transaction([update, activityStmt(user.id, `Updated ${name}`)]);
  refreshHq();
  return { ok: true };
}
