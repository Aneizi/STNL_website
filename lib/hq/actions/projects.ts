"use server";

import { z } from "zod";
import { requireUser } from "../auth";
import { builderDatabase } from "../builder-db";
import { getSql } from "../db";
import { requireHackathon } from "../hackathon";
import { isTrafficLightStatus } from "../project-status";
import { deleteTeamRecord } from "../record-deletion";
import type { ActionResult } from "../types";
import { activityStmt, hqToday, inHackathon, refreshHq } from "./util";

// Every action that takes a record id resolves it through inHackathon():
// the record must exist and belong to the edition the operator is working
// in (the hq_hackathon cookie names that edition and authorizes nothing on
// its own), and a missing record and one from another edition answer the
// same way, so neither a form field nor a swapped cookie can reach a record
// outside the selected edition.

const id = z.string().uuid();
const text = (max: number) => z.string().max(max);

type ProjectRef = { name: string; hackathonId: number; imported: boolean };

/** The project's name and hackathon (for touch + activity), or null for a stale id. */
async function getProject(projectId: string): Promise<ProjectRef | null> {
  const sql = getSql();
  const rows = await sql`SELECT p.name, p.hackathon_id,
    EXISTS(SELECT 1 FROM hq_project_onboarding o WHERE o.project_id = p.id) AS imported
    FROM hq_projects p WHERE p.id = ${projectId}`;
  return rows[0] ? { name: rows[0].name, hackathonId: Number(rows[0].hackathon_id), imported: Boolean(rows[0].imported) } : null;
}

const createSchema = z.object({
  name: z.string().min(1).max(200),
  leadName: text(200),
  leadContact: text(200),
  partnerId: id.nullable(),
  eventSrc: text(200),
});

export async function createProject(input: z.infer<typeof createSchema>): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Project name is required." };
  const { leadName, leadContact, partnerId, eventSrc } = parsed.data;
  const name = parsed.data.name.trim();
  if (!name) return { ok: false, error: "Project name is required." };

  const sql = getSql();
  const today = await hqToday(hackathon.id);
  // Mirrors the design: new projects start green/likely. The lead is always
  // on the team, so there is no separate member row to create. A partner from
  // another hackathon cannot be attached: the subselect yields NULL for it.
  await sql.transaction([
    sql`
      INSERT INTO hq_projects
        (hackathon_id, name, lead_name, lead_contact, partner_id, event_src,
         status_id, forecast_id, last_check_in, touched_by_user_id, touched_at)
      VALUES
        (${hackathon.id}, ${name}, ${leadName}, ${leadContact},
         (SELECT id FROM hq_partners
          WHERE id = ${partnerId}::uuid AND hackathon_id = ${hackathon.id}),
         ${eventSrc},
         (SELECT id FROM hq_project_statuses WHERE slug = 'green'),
         (SELECT id FROM hq_project_forecasts WHERE slug = 'likely'),
         ${today}, ${user.id}, ${today})
    `,
    activityStmt(user.id, hackathon.id, `Added project ${name}`),
  ]);
  refreshHq();
  return { ok: true };
}

const detailField = z.discriminatedUnion("field", [
  z.object({ field: z.literal("name"), value: z.string().min(1).max(200) }),
  z.object({ field: z.literal("leadName"), value: text(200) }),
  z.object({ field: z.literal("leadContact"), value: text(200) }),
  z.object({ field: z.literal("eventSrc"), value: text(200) }),
  z.object({ field: z.literal("partnerId"), value: id.nullable() }),
]);

export async function updateProjectDetail(
  projectId: string,
  input: z.infer<typeof detailField>,
): Promise<ActionResult> {
  const user = await requireUser();
  const selected = await requireHackathon();
  if (!id.safeParse(projectId).success) return { ok: false };
  const parsed = detailField.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid value." };

  const project = inHackathon(await getProject(projectId), selected.id);
  if (!project) return { ok: false, error: "Project not found in this hackathon." };
  // An imported project's lead is one of its Colosseum roster rows, chosen
  // through updateBuilderProjectLead; free text would detach the name from
  // the identity behind it.
  if (project.imported && parsed.data.field === "leadName") {
    return { ok: false, error: "Choose the lead from the project's Colosseum roster." };
  }
  const { name, hackathonId } = project;

  const sql = getSql();
  const today = await hqToday(hackathonId);
  const touch = sql`
    UPDATE hq_projects SET touched_by_user_id = ${user.id}, touched_at = ${today}
    WHERE id = ${projectId}
  `;

  const data = parsed.data;
  let update;
  let message: string;
  switch (data.field) {
    case "name": {
      const trimmed = data.value.trim();
      if (!trimmed) return { ok: false };
      update = sql`UPDATE hq_projects SET name = ${trimmed} WHERE id = ${projectId}`;
      message = `Renamed project to ${trimmed}`;
      break;
    }
    case "leadName":
      update = sql`UPDATE hq_projects SET lead_name = ${data.value} WHERE id = ${projectId}`;
      message = `Updated ${name}`;
      break;
    case "leadContact":
      update = sql`UPDATE hq_projects SET lead_contact = ${data.value} WHERE id = ${projectId}`;
      message = `Updated ${name}`;
      break;
    case "eventSrc":
      update = sql`UPDATE hq_projects SET event_src = ${data.value} WHERE id = ${projectId}`;
      message = `Updated ${name}`;
      break;
    case "partnerId":
      // Only a partner of the same hackathon can be attached; any other id
      // clears the attribution rather than crossing editions.
      update = sql`
        UPDATE hq_projects
        SET partner_id = (SELECT id FROM hq_partners
                          WHERE id = ${data.value}::uuid AND hackathon_id = ${hackathonId})
        WHERE id = ${projectId}
      `;
      message = `Updated ${name}`;
      break;
  }

  await sql.transaction([update, touch, activityStmt(user.id, hackathonId, message)]);
  refreshHq();
  return { ok: true };
}

/** The member's project (for touch + activity), or null for a stale id. */
async function getMemberProject(
  memberId: string,
): Promise<{ projectId: string; projectName: string; hackathonId: number; imported: boolean } | null> {
  const sql = getSql();
  const rows = await sql`
    SELECT m.project_id, p.name, p.hackathon_id,
      EXISTS(SELECT 1 FROM hq_project_onboarding o WHERE o.project_id = p.id) AS imported
    FROM hq_project_members m
    JOIN hq_projects p ON p.id = m.project_id
    WHERE m.id = ${memberId}
  `;
  return rows[0]
    ? { projectId: rows[0].project_id, projectName: rows[0].name, hackathonId: Number(rows[0].hackathon_id), imported: Boolean(rows[0].imported) }
    : null;
}

export async function addProjectMember(
  projectId: string,
  memberName: string,
  memberContact: string,
): Promise<ActionResult> {
  const user = await requireUser();
  const selected = await requireHackathon();
  if (!id.safeParse(projectId).success) return { ok: false };
  const parsedName = text(200).safeParse(memberName);
  const parsedContact = text(200).safeParse(memberContact);
  if (!parsedName.success || !parsedContact.success) return { ok: false };
  const trimmedName = parsedName.data.trim();
  if (!trimmedName) return { ok: false };
  const project = inHackathon(await getProject(projectId), selected.id);
  if (!project) return { ok: false, error: "Project not found in this hackathon." };
  if (project.imported) return { ok: false, error: "The roster of an imported project comes from Colosseum and cannot be extended in HQ." };

  const sql = getSql();
  const today = await hqToday(project.hackathonId);
  // max+1 keeps new teammates at the end; parameters carry explicit casts
  // because a bare SELECT list gives Postgres nothing to infer types from.
  await sql.transaction([
    sql`
      INSERT INTO hq_project_members (project_id, name, contact, sort)
      SELECT ${projectId}::uuid, ${trimmedName}::text, ${parsedContact.data}::text,
        COALESCE(max(sort), 0) + 1
      FROM hq_project_members WHERE project_id = ${projectId}::uuid
    `,
    sql`
      UPDATE hq_projects SET touched_by_user_id = ${user.id}, touched_at = ${today}
      WHERE id = ${projectId}
    `,
    activityStmt(user.id, project.hackathonId, `Updated team on ${project.name}`),
  ]);
  refreshHq();
  return { ok: true };
}

const memberField = z.discriminatedUnion("field", [
  z.object({ field: z.literal("name"), value: z.string().min(1).max(200) }),
  z.object({ field: z.literal("contact"), value: text(200) }),
]);

export async function updateProjectMember(
  memberId: string,
  input: z.infer<typeof memberField>,
): Promise<ActionResult> {
  const user = await requireUser();
  const selected = await requireHackathon();
  if (!id.safeParse(memberId).success) return { ok: false };
  const parsed = memberField.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid value." };
  const member = inHackathon(await getMemberProject(memberId), selected.id);
  if (!member) return { ok: false, error: "Teammate not found in this hackathon." };
  if (member.imported && parsed.data.field === "name") return { ok: false, error: "This teammate's name comes from Colosseum. Only the contact can be edited in HQ." };

  const sql = getSql();
  const today = await hqToday(member.hackathonId);
  const data = parsed.data;
  const trimmedName = data.field === "name" ? data.value.trim() : "";
  if (data.field === "name" && !trimmedName) return { ok: false };
  const update =
    data.field === "name"
      ? sql`UPDATE hq_project_members SET name = ${trimmedName} WHERE id = ${memberId}`
      : sql`UPDATE hq_project_members SET contact = ${data.value} WHERE id = ${memberId}`;
  await sql.transaction([
    update,
    sql`
      UPDATE hq_projects SET touched_by_user_id = ${user.id}, touched_at = ${today}
      WHERE id = ${member.projectId}
    `,
    activityStmt(user.id, member.hackathonId, `Updated team on ${member.projectName}`),
  ]);
  refreshHq();
  return { ok: true };
}

export async function removeProjectMember(memberId: string): Promise<ActionResult> {
  const user = await requireUser();
  const selected = await requireHackathon();
  if (!id.safeParse(memberId).success) return { ok: false };
  const member = inHackathon(await getMemberProject(memberId), selected.id);
  if (!member) return { ok: false, error: "Teammate not found in this hackathon." };
  if (member.imported) return { ok: false, error: "This teammate is on the Colosseum roster and cannot be removed in HQ." };

  const sql = getSql();
  const today = await hqToday(member.hackathonId);
  await sql.transaction([
    sql`DELETE FROM hq_project_members WHERE id = ${memberId}`,
    sql`
      UPDATE hq_projects SET touched_by_user_id = ${user.id}, touched_at = ${today}
      WHERE id = ${member.projectId}
    `,
    activityStmt(user.id, member.hackathonId, `Updated team on ${member.projectName}`),
  ]);
  refreshHq();
  return { ok: true };
}

/**
 * Status change. In Monday-review mode the design persists the pick and
 * touches the project but does NOT log activity; the Log button does that.
 */
export async function setProjectStatus(
  projectId: string,
  statusSlug: string,
  opts?: { review?: boolean },
): Promise<ActionResult> {
  const user = await requireUser();
  const selected = await requireHackathon();
  if (!id.safeParse(projectId).success) return { ok: false };
  const project = inHackathon(await getProject(projectId), selected.id);
  if (!project) return { ok: false };

  const sql = getSql();
  const today = await hqToday(project.hackathonId);
  const statusRows = await sql`SELECT id FROM hq_project_statuses WHERE slug = ${statusSlug}`;
  if (!statusRows[0]) return { ok: false };

  const statements = [
    sql`
      UPDATE hq_projects
      SET status_id = ${statusRows[0].id}, touched_by_user_id = ${user.id}, touched_at = ${today}
      WHERE id = ${projectId}
    `,
  ];
  if (!opts?.review) {
    statements.push(
      activityStmt(user.id, project.hackathonId, `Set ${project.name} to ${statusSlug}`),
    );
  }
  await sql.transaction(statements);
  refreshHq();
  return { ok: true };
}

export async function setProjectForecast(
  projectId: string,
  forecastSlug: string,
): Promise<ActionResult> {
  const user = await requireUser();
  const selected = await requireHackathon();
  if (!id.safeParse(projectId).success) return { ok: false };
  const project = inHackathon(await getProject(projectId), selected.id);
  if (!project) return { ok: false };

  const sql = getSql();
  const today = await hqToday(project.hackathonId);
  const forecastRows = await sql`SELECT id FROM hq_project_forecasts WHERE slug = ${forecastSlug}`;
  if (!forecastRows[0]) return { ok: false };

  await sql.transaction([
    sql`
      UPDATE hq_projects
      SET forecast_id = ${forecastRows[0].id}, touched_by_user_id = ${user.id}, touched_at = ${today}
      WHERE id = ${projectId}
    `,
    activityStmt(
      user.id,
      project.hackathonId,
      `Moved ${project.name} to ${forecastSlug.replace("_", " ")}`,
    ),
  ]);
  refreshHq();
  return { ok: true };
}

export async function toggleProjectGate(
  projectId: string,
  gateId: string,
  done: boolean,
): Promise<ActionResult> {
  const user = await requireUser();
  const selected = await requireHackathon();
  if (!id.safeParse(projectId).success || !id.safeParse(gateId).success) return { ok: false };
  const project = inHackathon(await getProject(projectId), selected.id);
  if (!project) return { ok: false };

  const sql = getSql();
  const today = await hqToday(project.hackathonId);
  // A gate can only be ticked on a project of its own hackathon; the guard
  // lives in SQL so a stale form cannot cross editions.
  const write = done
    ? sql`
        INSERT INTO hq_project_gates (project_id, gate_id)
        SELECT ${projectId}::uuid, g.id FROM hq_submission_gates g
        WHERE g.id = ${gateId}::uuid AND g.hackathon_id = ${project.hackathonId}
        ON CONFLICT DO NOTHING
      `
    : sql`
        DELETE FROM hq_project_gates WHERE project_id = ${projectId} AND gate_id = ${gateId}
      `;
  await sql.transaction([
    write,
    sql`
      UPDATE hq_projects SET touched_by_user_id = ${user.id}, touched_at = ${today}
      WHERE id = ${projectId}
    `,
    activityStmt(
      user.id,
      project.hackathonId,
      `${done ? "Checked" : "Unchecked"} gate on ${project.name}`,
    ),
  ]);
  refreshHq();
  return { ok: true };
}

/**
 * The operator's own "high potential" flag, on the project row itself so it
 * works for a project created in HQ as well as an imported one. The board
 * renders it as the HP badge beside the name and the toggle in the
 * Colosseum block.
 */
export async function setProjectHighPotential(
  projectId: string,
  highPotential: boolean,
): Promise<ActionResult> {
  const user = await requireUser();
  const selected = await requireHackathon();
  if (!id.safeParse(projectId).success || typeof highPotential !== "boolean") return { ok: false };
  const project = inHackathon(await getProject(projectId), selected.id);
  if (!project) return { ok: false };

  const sql = getSql();
  const today = await hqToday(project.hackathonId);
  await sql.transaction([
    sql`
      UPDATE hq_projects
      SET high_potential = ${highPotential}, touched_by_user_id = ${user.id}, touched_at = ${today}
      WHERE id = ${projectId}
    `,
    activityStmt(
      user.id,
      project.hackathonId,
      highPotential ? `Marked ${project.name} high potential` : `Removed high potential from ${project.name}`,
    ),
  ]);
  refreshHq();
  return { ok: true };
}

export async function saveProjectBlocker(
  projectId: string,
  blocker: string,
): Promise<ActionResult> {
  const user = await requireUser();
  const selected = await requireHackathon();
  if (!id.safeParse(projectId).success) return { ok: false };
  const parsed = text(500).safeParse(blocker);
  if (!parsed.success) return { ok: false };
  const project = inHackathon(await getProject(projectId), selected.id);
  if (!project) return { ok: false };

  const sql = getSql();
  const today = await hqToday(project.hackathonId);
  await sql.transaction([
    sql`
      UPDATE hq_projects
      SET blocker = ${parsed.data}, touched_by_user_id = ${user.id}, touched_at = ${today}
      WHERE id = ${projectId}
    `,
    activityStmt(user.id, project.hackathonId, `Updated blocker on ${project.name}`),
  ]);
  refreshHq();
  return { ok: true };
}

export async function addProjectNote(projectId: string, body: string): Promise<ActionResult> {
  const user = await requireUser();
  const selected = await requireHackathon();
  if (!id.safeParse(projectId).success) return { ok: false };
  const parsed = z.string().min(1).max(2000).safeParse(body);
  if (!parsed.success) return { ok: false };
  const project = inHackathon(await getProject(projectId), selected.id);
  if (!project) return { ok: false };

  const sql = getSql();
  const today = await hqToday(project.hackathonId);
  await sql.transaction([
    sql`
      INSERT INTO hq_project_notes (project_id, author_user_id, body)
      VALUES (${projectId}, ${user.id}, ${parsed.data})
    `,
    sql`
      UPDATE hq_projects SET touched_by_user_id = ${user.id}, touched_at = ${today}
      WHERE id = ${projectId}
    `,
    activityStmt(user.id, project.hackathonId, `Note on ${project.name}`),
  ]);
  refreshHq();
  return { ok: true };
}

/**
 * Deletes a project and everything hanging off it. Gates, notes, members and
 * the finalist row cascade in the schema; an award won by that finalist has
 * its winner cleared rather than being deleted. Two-step confirmed in the UI,
 * so there is no soft-delete to undo it from.
 *
 * The statement itself lives in `lib/hq/record-deletion.ts` (deleteTeamRecord):
 * one transaction, every dependent row removed or explicitly detached, and a
 * `project.deleted` audit event naming what went. This is the only delete
 * path for a project, imported or not, so nothing can strand a Captain
 * assignment or a reporting entry by taking a second route.
 */
export async function deleteProject(projectId: string): Promise<ActionResult> {
  const user = await requireUser();
  const selected = await requireHackathon();
  if (!id.safeParse(projectId).success) return { ok: false };
  const removed = await deleteTeamRecord(builderDatabase(), { projectId, hackathonId: selected.id, operatorId: user.id });
  if (!removed) return { ok: false, error: "Project not found." };
  refreshHq();
  return { ok: true };
}

/**
 * Rewrites a note in place. The note keeps its author and its position in the
 * timeline (created_at is untouched); edited_at is what the timeline shows as
 * "(edited)". Any operator can correct any note — the same open model the rest
 * of the board uses — so the activity feed records who did it.
 */
export async function editProjectNote(noteId: string, body: string): Promise<ActionResult> {
  const user = await requireUser();
  const selected = await requireHackathon();
  if (!id.safeParse(noteId).success) return { ok: false };
  const parsed = z.string().min(1).max(2000).safeParse(body);
  if (!parsed.success) return { ok: false };

  const sql = getSql();
  const rows = await sql`
    SELECT p.id AS project_id, p.name, p.hackathon_id
    FROM hq_project_notes n
    JOIN hq_projects p ON p.id = n.project_id
    WHERE n.id = ${noteId}
  `;
  const note = inHackathon(
    rows[0] ? { projectId: String(rows[0].project_id), name: String(rows[0].name), hackathonId: Number(rows[0].hackathon_id) } : null,
    selected.id,
  );
  if (!note) return { ok: false };

  const today = await hqToday(note.hackathonId);
  await sql.transaction([
    sql`
      UPDATE hq_project_notes SET body = ${parsed.data}, edited_at = now()
      WHERE id = ${noteId}
    `,
    sql`
      UPDATE hq_projects SET touched_by_user_id = ${user.id}, touched_at = ${today}
      WHERE id = ${note.projectId}
    `,
    activityStmt(user.id, note.hackathonId, `Edited note on ${note.name}`),
  ]);
  refreshHq();
  return { ok: true };
}

/**
 * The Log button in Monday review: stamps today's check-in, saves the
 * blocker draft (when provided), and appends the review note.
 */
export async function logMondayReview(
  projectId: string,
  blocker: string | undefined,
): Promise<ActionResult> {
  const user = await requireUser();
  const selected = await requireHackathon();
  if (!id.safeParse(projectId).success) return { ok: false };
  if (blocker !== undefined && !text(500).safeParse(blocker).success) return { ok: false };

  const sql = getSql();
  const rows = await sql`
    SELECT p.name, p.blocker, p.hackathon_id, s.slug AS status_slug
    FROM hq_projects p
    JOIN hq_project_statuses s ON s.id = p.status_id
    WHERE p.id = ${projectId}
  `;
  const project = inHackathon(
    rows[0]
      ? { name: String(rows[0].name), blocker: rows[0].blocker as string | null, hackathonId: Number(rows[0].hackathon_id), statusSlug: String(rows[0].status_slug) }
      : null,
    selected.id,
  );
  if (!project) return { ok: false };

  const finalBlocker = blocker !== undefined ? blocker : project.blocker;
  const reviewStatus = isTrafficLightStatus(project.statusSlug) ? "" : `${project.statusSlug}, `;
  const noteBody = `Monday review: ${reviewStatus}${finalBlocker ? `blocker: ${finalBlocker}` : "no blocker"}`;

  const today = await hqToday(project.hackathonId);
  // Only rewrite the blocker column when the reviewer actually typed one —
  // the read-back value could race a save from another operator.
  const updateStmt =
    blocker !== undefined
      ? sql`
          UPDATE hq_projects
          SET blocker = ${blocker}, last_check_in = ${today},
              touched_by_user_id = ${user.id}, touched_at = ${today}
          WHERE id = ${projectId}
        `
      : sql`
          UPDATE hq_projects
          SET last_check_in = ${today},
              touched_by_user_id = ${user.id}, touched_at = ${today}
          WHERE id = ${projectId}
        `;
  await sql.transaction([
    updateStmt,
    sql`
      INSERT INTO hq_project_notes (project_id, author_user_id, body)
      VALUES (${projectId}, ${user.id}, ${noteBody})
    `,
    activityStmt(user.id, project.hackathonId, `Monday review logged for ${project.name}`),
  ]);
  refreshHq();
  return { ok: true };
}
