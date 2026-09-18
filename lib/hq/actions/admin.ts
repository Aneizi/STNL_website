"use server";

import { z } from "zod";
import { requireUser } from "../auth";
import { getSql } from "../db";
import { requireHackathon } from "../hackathon";
import type { ActionResult } from "../types";
import { activityStmt, refreshHq } from "./util";

const id = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const milestoneSchema = z.object({
  date: isoDate,
  label: z.string().min(1).max(200),
});

export async function addMilestone(
  input: z.infer<typeof milestoneSchema>,
): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  const parsed = milestoneSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Date and label are required." };

  const sql = getSql();
  await sql.transaction([
    sql`
      INSERT INTO hq_milestones (hackathon_id, date, label)
      VALUES (${hackathon.id}, ${parsed.data.date}, ${parsed.data.label})
    `,
    activityStmt(user.id, hackathon.id, "Updated campaign settings"),
  ]);
  refreshHq();
  return { ok: true };
}

async function milestoneHackathon(milestoneId: string): Promise<number | null> {
  const sql = getSql();
  const rows = await sql`SELECT hackathon_id FROM hq_milestones WHERE id = ${milestoneId}`;
  return rows[0] ? Number(rows[0].hackathon_id) : null;
}

export async function updateMilestone(
  milestoneId: string,
  input: z.infer<typeof milestoneSchema>,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(milestoneId).success) return { ok: false };
  const parsed = milestoneSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Date and label are required." };
  const hackathonId = await milestoneHackathon(milestoneId);
  if (!hackathonId) return { ok: false };

  const sql = getSql();
  await sql.transaction([
    sql`
      UPDATE hq_milestones SET date = ${parsed.data.date}, label = ${parsed.data.label}
      WHERE id = ${milestoneId}
    `,
    activityStmt(user.id, hackathonId, "Updated campaign settings"),
  ]);
  refreshHq();
  return { ok: true };
}

export async function deleteMilestone(milestoneId: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(milestoneId).success) return { ok: false };
  const hackathonId = await milestoneHackathon(milestoneId);
  if (!hackathonId) return { ok: false };

  const sql = getSql();
  await sql.transaction([
    sql`DELETE FROM hq_milestones WHERE id = ${milestoneId}`,
    activityStmt(user.id, hackathonId, "Updated campaign settings"),
  ]);
  refreshHq();
  return { ok: true };
}
