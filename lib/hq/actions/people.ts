"use server";

import { z } from "zod";
import { requireUser } from "../auth";
import { builderDatabase } from "../builder-db";
import { BuilderError } from "../builder-types";
import { correctPersonMatch as correctPersonMatchRecord } from "../crm-identity";
import { getSql } from "../db";
import { requireHackathon } from "../hackathon";
import { deletePersonRecord } from "../record-deletion";
import type { ActionResult } from "../types";
import { grantCaptainCapability, revokeCaptainCapability } from "./capabilities";
import { activityStmt, inHackathon, refreshHq } from "./util";

const id = z.string().uuid();
const text = (max: number) => z.string().max(max);

/** A Telegram username as Telegram defines it, with or without the leading @: 5 to 32 letters, digits or underscores. */
const TELEGRAM_HANDLE = /^@?[A-Za-z0-9_]{5,32}$/;

const createSchema = z.object({
  name: z.string().min(1).max(200),
  roleId: id,
  telegram: text(64),
  email: text(200),
});

/**
 * Adds a hand-entered card. The form takes a Telegram handle and an email,
 * both optional, and the card keeps one contact (hq_people.contact): the
 * handle when given, stored as "@handle", else the email.
 */
export async function createPerson(input: z.infer<typeof createSchema>): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Name is required." };
  const { roleId } = parsed.data;
  const name = parsed.data.name.trim();
  if (!name) return { ok: false, error: "Name is required." };
  const telegram = parsed.data.telegram.trim();
  if (telegram && !TELEGRAM_HANDLE.test(telegram)) {
    return { ok: false, error: "Telegram handles are 5 to 32 letters, digits or underscores." };
  }
  const email = parsed.data.email.trim();
  if (email && !z.email().safeParse(email).success) return { ok: false, error: "Enter a valid email address." };
  const contact = telegram ? `@${telegram.replace(/^@/, "")}` : email;

  const sql = getSql();
  await sql.transaction([
    sql`
      INSERT INTO hq_people (hackathon_id, name, role_id, contact)
      VALUES (${hackathon.id}, ${name}, ${roleId}, ${contact})
    `,
    activityStmt(user.id, hackathon.id, `Added ${name} to people`),
  ]);
  refreshHq();
  return { ok: true };
}

const personField = z.discriminatedUnion("field", [
  z.object({ field: z.literal("name"), value: z.string().min(1).max(200) }),
  z.object({ field: z.literal("roleId"), value: id }),
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
    case "notes":
      update = sql`UPDATE hq_people SET notes = ${data.value} WHERE id = ${personId}`;
      break;
  }

  await sql.transaction([update, activityStmt(user.id, hackathonId, `Updated ${name}`)]);
  refreshHq();
  return { ok: true };
}

/**
 * Grants or removes Captain from a People card. The card id is the only
 * input: the account is the card's own builder_user_id, read here within the
 * selected edition (a card from another edition, or a missing one, answers
 * "Person not found."), and a hand-entered card without an account is
 * refused. The grant and the revocation themselves, with their audit events
 * and, on revoke, the clearing of the account's current project
 * assignments, stay in ./capabilities; this only supplies the fixed reason
 * the People control does not collect. Editing a role or a tag still never
 * grants anything: this is an explicit action on the linked account.
 */
export async function setPersonCaptain(personId: string, captain: boolean): Promise<ActionResult> {
  await requireUser();
  const selected = await requireHackathon();
  if (!id.safeParse(personId).success || typeof captain !== "boolean") return { ok: false, error: "Invalid person." };
  const sql = getSql();
  const rows = await sql`SELECT hackathon_id, builder_user_id FROM hq_people WHERE id = ${personId}`;
  const person = inHackathon(
    rows[0] ? { hackathonId: Number(rows[0].hackathon_id), userId: typeof rows[0].builder_user_id === "string" ? rows[0].builder_user_id : null } : null,
    selected.id,
  );
  if (!person) return { ok: false, error: "Person not found." };
  if (!person.userId) return { ok: false, error: "This person has no HQ account yet." };
  return captain
    ? grantCaptainCapability(person.userId, "Granted from People")
    : revokeCaptainCapability(person.userId, "Removed from People");
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

const deletePersonSchema = z.object({ personId: id, confirmed: z.literal(true) });

/**
 * Deletes a People card, and the CRM person behind it when this was that
 * person's last card anywhere. Operator only, edition scoped (a card from
 * another edition answers exactly like a missing one), audited as
 * `person.deleted`, one transaction — see `lib/hq/record-deletion.ts`.
 *
 * The HQ **account** is never deleted: a card is CRM, an account is a login.
 * Roster rows that pointed at the person are detached, not removed, because a
 * roster row is the imported team's record of who was on it.
 */
export async function deletePerson(input: z.infer<typeof deletePersonSchema>): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  const parsed = deletePersonSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Tick the confirmation to delete this person." };
  const removed = await deletePersonRecord(builderDatabase(), {
    cardId: parsed.data.personId, hackathonId: hackathon.id, operatorId: user.id,
  });
  if (!removed) return { ok: false, error: "Person not found." };
  refreshHq();
  return { ok: true };
}
