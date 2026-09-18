"use server";

import { z } from "zod";
import { requireUser } from "../auth";
import { builderDatabase } from "../builder-db";
import { builderStore } from "../builder-store";
import { BuilderError } from "../builder-types";
import { getSql } from "../db";
import { requireHackathon } from "../hackathon";
import { attachColosseumSource } from "../project-import";
import { deleteTeamRecord } from "../record-deletion";
import type { ActionResult } from "../types";
import { refreshHq } from "./util";

const uuid = z.string().uuid();
const signupUrl = z.url().max(500).refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.hostname === "colosseum.com" && !url.username && !url.password;
}, "Use an HTTPS Colosseum URL.");
const configSchema = z.object({
  externalHackathonId: z.number().int().positive().max(2147483647).nullable(),
  externalHackathonSlug: z.string().trim().max(200).regex(/^[a-zA-Z0-9_-]*$/),
  projectsOpen: z.boolean(),
  projectsAvailableAt: z.union([z.iso.datetime({ offset: true }), z.literal("")]),
  signupUrl,
  // Accepted but no longer written: Admin dropped the event-hosting switch
  // with the design, and the column keeps whatever it held.
  hostingEnabled: z.boolean().optional(),
}).refine((value) => !value.projectsOpen || (value.externalHackathonId !== null && value.externalHackathonSlug !== ""), {
  message: "Set the Colosseum hackathon ID and slug before enabling imports.",
});

export async function updateBuilderOnboardingConfig(input: z.infer<typeof configSchema>): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the onboarding settings." };
  const data = parsed.data;
  const sql = getSql();
  const rows = await sql`
    WITH changed AS (
      INSERT INTO hq_hackathon_onboarding (hackathon_id, external_hackathon_id,
        external_hackathon_slug, projects_open, projects_available_at, signup_url)
      VALUES (${hackathon.id}, ${data.externalHackathonId}, ${data.externalHackathonSlug || null},
        ${data.projectsOpen}, ${data.projectsAvailableAt || null}::timestamptz, ${data.signupUrl})
      ON CONFLICT (hackathon_id) DO UPDATE SET
        external_hackathon_id = EXCLUDED.external_hackathon_id,
        external_hackathon_slug = EXCLUDED.external_hackathon_slug,
        projects_open = EXCLUDED.projects_open, projects_available_at = EXCLUDED.projects_available_at,
        signup_url = EXCLUDED.signup_url
      WHERE (hq_hackathon_onboarding.external_hackathon_id IS NOT DISTINCT FROM EXCLUDED.external_hackathon_id
        AND hq_hackathon_onboarding.external_hackathon_slug IS NOT DISTINCT FROM EXCLUDED.external_hackathon_slug)
        OR NOT EXISTS (SELECT 1 FROM hq_project_onboarding WHERE hackathon_id = ${hackathon.id})
      RETURNING hackathon_id
    ), logged AS (
      INSERT INTO hq_activity (hackathon_id, user_id, message)
      SELECT hackathon_id, ${user.id}::uuid, 'Updated builder onboarding settings' FROM changed
    ) SELECT hackathon_id FROM changed
  `;
  if (!rows.length) return { ok: false, error: "This hackathon already has imported teams. Its Colosseum mapping cannot be changed." };
  refreshHq();
  return { ok: true };
}

export async function updateBuilderTier(builderId: string, tier: "regular" | "member"): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  if (!z.string().min(1).max(200).safeParse(builderId).success || !z.enum(["regular", "member"]).safeParse(tier).success) {
    return { ok: false, error: "Choose Regular or Member." };
  }
  const sql = getSql();
  // Tier belongs to the account globally. The selected CRM limits which accounts can be managed here.
  const rows = await sql`
    WITH changed AS (
      UPDATE hq_builder_profiles b SET tier = ${tier}
      WHERE b.id = ${builderId} AND EXISTS (SELECT 1 FROM hq_people p
        WHERE p.builder_user_id = b.id AND p.hackathon_id = ${hackathon.id})
      RETURNING b.id
    ), logged AS (
      INSERT INTO hq_activity (hackathon_id, user_id, message)
      SELECT ${hackathon.id}, ${user.id}::uuid, ${`Updated builder membership to ${tier}`} FROM changed
    ) SELECT id FROM changed
  `;
  if (!rows.length) return { ok: false, error: "Account not found in this hackathon." };
  refreshHq();
  return { ok: true };
}

export async function markBuilderProjectPotential(projectId: string, highPotential: boolean): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  if (!uuid.safeParse(projectId).success || typeof highPotential !== "boolean") return { ok: false, error: "Invalid project." };
  const sql = getSql();
  const rows = await sql`
    WITH changed AS (
      UPDATE hq_project_onboarding SET high_potential = ${highPotential}
      WHERE project_id = ${projectId}::uuid AND hackathon_id = ${hackathon.id}
      RETURNING project_id
    ), logged AS (
      INSERT INTO hq_activity (hackathon_id, user_id, message)
      SELECT ${hackathon.id}, ${user.id}::uuid, ${highPotential ? "Marked a team high potential" : "Removed a team's high potential flag"} FROM changed
    ) SELECT project_id FROM changed
  `;
  if (!rows.length) return { ok: false, error: "Imported project not found in this hackathon." };
  refreshHq();
  return { ok: true };
}

export async function updateBuilderProjectLead(projectId: string, username: string): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  if (!uuid.safeParse(projectId).success || !z.string().min(1).max(200).safeParse(username).success) {
    return { ok: false, error: "Choose a lead from the imported team." };
  }
  const sql = getSql();
  const rows = await sql`
    WITH changed AS (
      UPDATE hq_project_onboarding o SET lead_username = m.colosseum_username
      FROM hq_project_members m
      WHERE o.project_id = ${projectId}::uuid AND o.hackathon_id = ${hackathon.id}
        AND m.project_id = o.project_id AND m.colosseum_username = ${username}
      RETURNING o.project_id, m.name
    ), project_updated AS (
      UPDATE hq_projects p SET lead_name = c.name FROM changed c
      WHERE p.id = c.project_id AND p.hackathon_id = ${hackathon.id}
    ), logged AS (
      INSERT INTO hq_activity (hackathon_id, user_id, message)
      SELECT ${hackathon.id}, ${user.id}::uuid, 'Selected a lead from the imported Colosseum team' FROM changed
    ) SELECT project_id FROM changed
  `;
  if (!rows.length) return { ok: false, error: "Choose a listed Colosseum teammate in this hackathon." };
  refreshHq();
  return { ok: true };
}

export async function resolveBuilderImportRequest(requestId: string): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  if (!uuid.safeParse(requestId).success) return { ok: false, error: "Invalid request." };
  const sql = getSql();
  const rows = await sql`
    WITH changed AS (
      UPDATE hq_project_import_requests SET status = 'resolved'
      WHERE id = ${requestId}::uuid AND hackathon_id = ${hackathon.id} RETURNING id
    ), logged AS (
      INSERT INTO hq_activity (hackathon_id, user_id, message)
      SELECT ${hackathon.id}, ${user.id}::uuid, 'Resolved a project import request' FROM changed
    ) SELECT id FROM changed
  `;
  if (!rows.length) return { ok: false, error: "Request not found in this hackathon." };
  refreshHq();
  return { ok: true };
}

/**
 * The plan's fallback for a project Colosseum cannot return yet: an admin
 * creates the HQ project by hand, owned by the account that asked for help.
 *
 * "Model HQ project ownership independently of a successful external
 * snapshot ... Do not invent external IDs, and do not mark an unavailable
 * source Submitted." So this writes an `hq_projects` row and an
 * `hq_project_ownership` row and nothing else: no fabricated external id, no
 * claimed project URL, no submission status. The requesting account can then
 * open the project, write its weekly updates and be given a Captain, which is
 * the access the request was asking for; what it does not get is a roster or
 * a Colosseum link, because there is not one yet.
 *
 * The request is resolved and records which project it became, so a second
 * press cannot create a second project for it.
 */
export async function createProjectFromImportRequest(input: { requestId: string; name: string }): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  const parsed = z.object({ requestId: uuid, name: z.string().trim().min(2).max(200) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Give the project a name of at least two characters." };
  try {
    const created = await builderStore().createProjectForRequest({
      requestId: parsed.data.requestId, hackathonId: hackathon.id, name: parsed.data.name, operatorId: user.id,
    });
    if (!created) return { ok: false, error: "Request not found in this hackathon." };
  } catch (error) {
    return { ok: false, error: error instanceof BuilderError ? error.message : "Could not create this project." };
  }
  refreshHq();
  return { ok: true };
}

/**
 * The other half of the fallback: the Colosseum project has become
 * available, and its snapshot is attached to the HQ project that already
 * exists rather than a second project being imported beside it.
 *
 * The HQ project id, its ownership, its Captain assignment and every weekly
 * update it has collected all survive, because it is the same project.
 */
export async function attachColosseumProject(input: { projectId: string; url: string }): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  const parsed = z.object({ projectId: uuid, url: signupUrl }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Use an HTTPS Colosseum project URL." };
  const outcome = await attachColosseumSource({
    projectId: parsed.data.projectId, hackathonId: hackathon.id, url: parsed.data.url, operatorId: user.id,
  });
  if (!outcome.ok) return { ok: false, error: outcome.message };
  refreshHq();
  return { ok: true };
}

const deleteTeamSchema = z.object({ projectId: uuid, confirmed: z.literal(true) });

/**
 * Deletes a team and every row that belongs to it, in one transaction
 * (`lib/hq/record-deletion.ts`). Operator only, edition scoped through the
 * usual resolution — the record must belong to the selected hackathon, so a
 * crafted id or a swapped `hq_hackathon` cookie reaches nothing — and
 * audited as `project.deleted`.
 *
 * The confirmation the operator ticked names the real counts, which the
 * screen read from `getBuilderProjectReviews()`; the transaction re-reads
 * them for the audit event, so the trail records what was actually removed.
 */
export async function deleteBuilderTeam(input: z.infer<typeof deleteTeamSchema>): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  const parsed = deleteTeamSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Tick the confirmation to delete this team." };
  const removed = await deleteTeamRecord(builderDatabase(), {
    projectId: parsed.data.projectId, hackathonId: hackathon.id, operatorId: user.id,
  });
  if (!removed) return { ok: false, error: "Project not found in this hackathon." };
  refreshHq();
  return { ok: true };
}
