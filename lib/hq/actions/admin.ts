"use server";

import { z } from "zod";
import { requireUser } from "../auth";
import { getSql } from "../db";
import { requireHackathon } from "../hackathon";
import type { ActionResult } from "../types";
import { activityStmt, refreshHq } from "./util";

const id = z.string().uuid();
const count = z.number().int().min(0).max(1_000_000);
const month = z.string().regex(/^\d{4}-\d{2}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Maps the editable settings to their storage keys with per-key validation.
const SETTINGS_SCHEMA = z.object({
  prospects_reached: count.optional(),
  prospects_target: count.optional(),
  committed_manual: count.optional(),
  committed_target: count.optional(),
  committed_glide: count.optional(),
  active_at_kickoff: count.optional(),
  active_target: count.optional(),
  verified_target: count.optional(),
  stale_days: z.number().int().min(1).max(365).optional(),
  finalist_cap: z.number().int().min(1).max(1000).optional(),
  verified_only_finalists: z.boolean().optional(),
  cal_start: month.optional(),
  cal_end: month.optional(),
  prospects_sub: z.string().max(200).optional(),
  active_sub: z.string().max(200).optional(),
});

export type SettingsPatch = z.infer<typeof SETTINGS_SCHEMA>;

/** Settings belong to the hackathon being shown; the cookie says which. */
export async function updateSettings(patch: SettingsPatch): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  const parsed = SETTINGS_SCHEMA.safeParse(patch);
  if (!parsed.success) return { ok: false, error: "Invalid settings values." };

  const entries = Object.entries(parsed.data).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return { ok: true };

  const sql = getSql();
  await sql.transaction([
    ...entries.map(
      ([key, value]) => sql`
        INSERT INTO hq_settings (hackathon_id, key, value)
        VALUES (${hackathon.id}, ${key}, ${JSON.stringify(value)}::jsonb)
        ON CONFLICT (hackathon_id, key) DO UPDATE SET value = ${JSON.stringify(value)}::jsonb
      `,
    ),
    activityStmt(user.id, hackathon.id, "Updated campaign settings"),
  ]);
  refreshHq();
  return { ok: true };
}

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
