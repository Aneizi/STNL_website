"use server";

import { z } from "zod";
import { requireUser } from "../auth";
import { getSql } from "../db";
import { requireHackathon } from "../hackathon";
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
  hostingEnabled: z.boolean(),
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
        external_hackathon_slug, projects_open, projects_available_at, signup_url, hosting_enabled)
      VALUES (${hackathon.id}, ${data.externalHackathonId}, ${data.externalHackathonSlug || null},
        ${data.projectsOpen}, ${data.projectsAvailableAt || null}::timestamptz, ${data.signupUrl}, ${data.hostingEnabled})
      ON CONFLICT (hackathon_id) DO UPDATE SET
        external_hackathon_id = EXCLUDED.external_hackathon_id,
        external_hackathon_slug = EXCLUDED.external_hackathon_slug,
        projects_open = EXCLUDED.projects_open, projects_available_at = EXCLUDED.projects_available_at,
        signup_url = EXCLUDED.signup_url, hosting_enabled = EXCLUDED.hosting_enabled
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

const reviewSchema = z.object({
  projectId: uuid,
  decision: z.enum(["verified", "rejected"]),
  reviewedEvidence: z.literal(true),
  note: z.string().trim().min(12).max(2000),
});

export async function reviewBuilderProject(input: z.infer<typeof reviewSchema>): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  const parsed = reviewSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Confirm you reviewed the project, owner and team. Add a review note of at least 12 characters." };
  const data = parsed.data;
  const sql = getSql();
  const rows = await sql`
    WITH changed AS (
      UPDATE hq_project_onboarding SET verification = ${data.decision}
      WHERE project_id = ${data.projectId}::uuid AND hackathon_id = ${hackathon.id}
        AND EXISTS (SELECT 1 FROM hq_projects p
          WHERE p.id = ${data.projectId}::uuid AND p.hackathon_id = ${hackathon.id})
      RETURNING project_id
    ), noted AS (
      INSERT INTO hq_project_notes (project_id, author_user_id, body)
      SELECT project_id, ${user.id}::uuid, ${`Team ${data.decision} by admin: ${data.note}`} FROM changed
    ), logged AS (
      INSERT INTO hq_activity (hackathon_id, user_id, message)
      SELECT ${hackathon.id}, ${user.id}::uuid, ${`Manually ${data.decision} an imported team`} FROM changed
    ) SELECT project_id FROM changed
  `;
  if (!rows.length) return { ok: false, error: "Imported project not found in this hackathon." };
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

export async function reviewBuilderHostRequest(requestId: string, status: "approved" | "declined"): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  if (!uuid.safeParse(requestId).success || !z.enum(["approved", "declined"]).safeParse(status).success) {
    return { ok: false, error: "Invalid hosting request." };
  }
  const sql = getSql();
  const rows = await sql`
    WITH changed AS (
      UPDATE hq_event_host_requests SET status = ${status}
      WHERE id = ${requestId}::uuid AND hackathon_id = ${hackathon.id} RETURNING id
    ), logged AS (
      INSERT INTO hq_activity (hackathon_id, user_id, message)
      SELECT ${hackathon.id}, ${user.id}::uuid, ${`Hosting request ${status}`} FROM changed
    ) SELECT id FROM changed
  `;
  if (!rows.length) return { ok: false, error: "Request not found in this hackathon." };
  refreshHq();
  return { ok: true };
}
