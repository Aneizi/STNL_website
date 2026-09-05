"use server";

import { z } from "zod";
import { requireUser } from "../auth";
import { getSql } from "../db";
import { requireHackathon } from "../hackathon";
import { getSettings } from "../queries";
import type { ActionResult } from "../types";
import { activityStmt, refreshHq } from "./util";

const id = z.string().uuid();

type ProjectRef = { name: string; hackathonId: number };

async function getProject(projectId: string): Promise<ProjectRef | null> {
  const sql = getSql();
  const rows = await sql`SELECT name, hackathon_id FROM hq_projects WHERE id = ${projectId}`;
  return rows[0] ? { name: rows[0].name, hackathonId: Number(rows[0].hackathon_id) } : null;
}

async function getAward(awardId: string): Promise<ProjectRef | null> {
  const sql = getSql();
  const rows = await sql`SELECT name, hackathon_id FROM hq_awards WHERE id = ${awardId}`;
  return rows[0] ? { name: rows[0].name, hackathonId: Number(rows[0].hackathon_id) } : null;
}

export async function addFinalist(projectId: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(projectId).success) return { ok: false };

  const sql = getSql();
  const project = await getProject(projectId);
  if (!project) return { ok: false };
  const settings = await getSettings(project.hackathonId);

  // Cap and eligibility are enforced inside the INSERT so the check and the
  // write share one snapshot; the unique (hackathon, position) index turns a
  // concurrent duplicate slot into a no-op failure instead of corrupt
  // ordering. Everything is counted within the project's own hackathon.
  let inserted: unknown[];
  try {
    inserted = await sql`
      INSERT INTO hq_finalists (project_id, hackathon_id, position)
      SELECT p.id, p.hackathon_id,
        COALESCE((SELECT max(f.position) FROM hq_finalists f
                  WHERE f.hackathon_id = p.hackathon_id), 0) + 1
      FROM hq_projects p
      WHERE p.id = ${projectId}::uuid
        AND (SELECT count(*) FROM hq_finalists f WHERE f.hackathon_id = p.hackathon_id)
            < ${settings.finalistCap}::int
        AND (
          ${!settings.verifiedOnlyFinalists}::boolean
          OR NOT EXISTS (
            SELECT 1 FROM hq_submission_gates g
            WHERE g.hackathon_id = p.hackathon_id
              AND NOT EXISTS (
                SELECT 1 FROM hq_project_gates pg
                WHERE pg.project_id = p.id AND pg.gate_id = g.id
              )
          )
        )
      ON CONFLICT (project_id) DO NOTHING
      RETURNING position
    `;
  } catch {
    return { ok: false, error: "Could not add the finalist. Try again." };
  }
  if (inserted.length === 0) {
    const already = await sql`SELECT 1 AS x FROM hq_finalists WHERE project_id = ${projectId}`;
    if (already.length > 0) return { ok: true };
    const [{ count }] = await sql`
      SELECT count(*)::int AS count FROM hq_finalists WHERE hackathon_id = ${project.hackathonId}
    `;
    return {
      ok: false,
      error:
        Number(count) >= settings.finalistCap
          ? `Finalist cap reached (${settings.finalistCap}).`
          : "Only projects with all gates passed can become finalists.",
    };
  }
  await activityStmt(user.id, project.hackathonId, `Added finalist ${project.name}`);
  refreshHq();
  return { ok: true };
}

export async function removeFinalist(projectId: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(projectId).success) return { ok: false };

  const sql = getSql();
  const project = await getProject(projectId);
  if (!project) return { ok: false };

  // Schema-level cascades keep related state consistent: the project's
  // scores are removed and any award pointing at it reverts to undecided.
  await sql.transaction([
    sql`DELETE FROM hq_finalists WHERE project_id = ${projectId}`,
    activityStmt(user.id, project.hackathonId, `Removed finalist ${project.name}`),
  ]);
  refreshHq();
  return { ok: true };
}

const awardSchema = z.object({
  name: z.string().min(1).max(200),
  amount: z.number().int().min(0).max(10_000_000),
});

export async function addAward(input: z.infer<typeof awardSchema>): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  const parsed = awardSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Award name is required." };
  const name = parsed.data.name.trim();
  if (!name) return { ok: false, error: "Award name is required." };

  const sql = getSql();
  await sql.transaction([
    sql`
      INSERT INTO hq_awards (hackathon_id, name, sponsor, amount, sort)
      SELECT ${hackathon.id}::int, ${name}::text, '', ${parsed.data.amount}::int,
        COALESCE(max(sort), 0) + 1
      FROM hq_awards WHERE hackathon_id = ${hackathon.id}::int
    `,
    activityStmt(user.id, hackathon.id, `Added award ${name}`),
  ]);
  refreshHq();
  return { ok: true };
}

export async function removeAward(awardId: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(awardId).success) return { ok: false };

  const sql = getSql();
  const award = await getAward(awardId);
  if (!award) return { ok: false };

  await sql.transaction([
    sql`DELETE FROM hq_awards WHERE id = ${awardId}`,
    activityStmt(user.id, award.hackathonId, `Removed award ${award.name}`),
  ]);
  refreshHq();
  return { ok: true };
}

export async function setAwardWinner(
  awardId: string,
  projectId: string | null,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(awardId).success) return { ok: false };
  if (projectId !== null && !id.safeParse(projectId).success) return { ok: false };

  const sql = getSql();
  const award = await getAward(awardId);
  if (!award) return { ok: false };

  // The guard (and the winner→finalists foreign key behind it) keeps a
  // forged or stale request from crowning a project that isn't a finalist —
  // of this award's own hackathon.
  const updated = await sql`
    UPDATE hq_awards SET winner_project_id = ${projectId}::uuid
    WHERE id = ${awardId}::uuid
      AND (
        ${projectId === null}::boolean
        OR EXISTS (SELECT 1 FROM hq_finalists
                   WHERE project_id = ${projectId}::uuid
                     AND hackathon_id = hq_awards.hackathon_id)
      )
    RETURNING id
  `;
  if (updated.length === 0) {
    return { ok: false, error: "Winners must be current finalists." };
  }
  await activityStmt(user.id, award.hackathonId, `Winner set for ${award.name}`);
  refreshHq();
  return { ok: true };
}

const scoreSchema = z.object({
  judgeId: id,
  projectId: id,
  score: z.number().int().min(1).max(10),
  note: z.string().max(500),
});

export async function addScore(input: z.infer<typeof scoreSchema>): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = scoreSchema.safeParse(input);
  if (!parsed.success) {
    const scoreIssue = !scoreSchema.shape.score.safeParse(input?.score).success;
    return {
      ok: false,
      error: scoreIssue
        ? "Score must be between 1 and 10."
        : "Judge, finalist, and a score are required.",
    };
  }
  const { judgeId, projectId, score, note } = parsed.data;

  const sql = getSql();
  // The judge must be a tracked person with a judging role in the finalist's
  // own hackathon, and the project must actually be a finalist — both
  // re-checked by the schema's foreign keys, so a concurrent removal cannot
  // slip a score past this check.
  const [judges, finalists] = await Promise.all([
    sql`
      SELECT p.name FROM hq_people p
      JOIN hq_people_roles r ON r.id = p.role_id
      WHERE r.is_judge AND p.id = ${judgeId}
        AND p.hackathon_id = (SELECT hackathon_id FROM hq_projects WHERE id = ${projectId})
    `,
    sql`SELECT hackathon_id FROM hq_finalists WHERE project_id = ${projectId}`,
  ]);
  if (judges.length === 0 || finalists.length === 0) {
    return { ok: false, error: "Judge, finalist, and a score are required." };
  }

  // One score per judge per finalist; re-entering replaces the earlier one.
  try {
    await sql.transaction([
      sql`
        INSERT INTO hq_scores (judge_id, project_id, score, note)
        VALUES (${judgeId}, ${projectId}, ${score}, ${note})
        ON CONFLICT (judge_id, project_id)
        DO UPDATE SET score = EXCLUDED.score, note = EXCLUDED.note
      `,
      activityStmt(user.id, finalists[0].hackathon_id, `${judges[0].name} scored a finalist`),
    ]);
  } catch {
    return { ok: false, error: "Judge, finalist, and a score are required." };
  }
  refreshHq();
  return { ok: true };
}

export async function clearScores(projectId: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(projectId).success) return { ok: false };

  const sql = getSql();
  const project = await getProject(projectId);
  if (!project) return { ok: false };

  await sql.transaction([
    sql`DELETE FROM hq_scores WHERE project_id = ${projectId}`,
    activityStmt(user.id, project.hackathonId, `Cleared scores for ${project.name}`),
  ]);
  refreshHq();
  return { ok: true };
}
