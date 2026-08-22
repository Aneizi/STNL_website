"use server";

import { z } from "zod";
import { requireUser } from "../auth";
import { getSql } from "../db";
import type { ActionResult } from "../types";
import { activityStmt, hqToday, refreshHq } from "./util";

const id = z.string().uuid();
const text = (max: number) => z.string().max(max);

async function getProjectName(projectId: string): Promise<string | null> {
  const sql = getSql();
  const rows = await sql`SELECT name FROM hq_projects WHERE id = ${projectId}`;
  return rows[0]?.name ?? null;
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
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Project name is required." };
  const { leadName, leadContact, partnerId, eventSrc } = parsed.data;
  const name = parsed.data.name.trim();
  if (!name) return { ok: false, error: "Project name is required." };

  const sql = getSql();
  const today = await hqToday();
  // Mirrors the design: new projects start green/likely. The lead is always
  // on the team, so there is no separate member row to create.
  await sql.transaction([
    sql`
      INSERT INTO hq_projects
        (name, lead_name, lead_contact, partner_id, event_src,
         status_id, forecast_id, last_check_in, touched_by_user_id, touched_at)
      VALUES
        (${name}, ${leadName}, ${leadContact}, ${partnerId}, ${eventSrc},
         (SELECT id FROM hq_project_statuses WHERE slug = 'green'),
         (SELECT id FROM hq_project_forecasts WHERE slug = 'likely'),
         ${today}, ${user.id}, ${today})
    `,
    activityStmt(user.id, `Added project ${name}`),
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
  if (!id.safeParse(projectId).success) return { ok: false };
  const parsed = detailField.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid value." };

  const name = await getProjectName(projectId);
  if (name === null) return { ok: false, error: "Project not found." };

  const sql = getSql();
  const today = await hqToday();
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
      update = sql`UPDATE hq_projects SET partner_id = ${data.value} WHERE id = ${projectId}`;
      message = `Updated ${name}`;
      break;
  }

  await sql.transaction([update, touch, activityStmt(user.id, message)]);
  refreshHq();
  return { ok: true };
}

/** The member's project (for touch + activity), or null for a stale id. */
async function getMemberProject(
  memberId: string,
): Promise<{ projectId: string; projectName: string } | null> {
  const sql = getSql();
  const rows = await sql`
    SELECT m.project_id, p.name FROM hq_project_members m
    JOIN hq_projects p ON p.id = m.project_id
    WHERE m.id = ${memberId}
  `;
  return rows[0] ? { projectId: rows[0].project_id, projectName: rows[0].name } : null;
}

export async function addProjectMember(
  projectId: string,
  memberName: string,
  memberContact: string,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(projectId).success) return { ok: false };
  const parsedName = text(200).safeParse(memberName);
  const parsedContact = text(200).safeParse(memberContact);
  if (!parsedName.success || !parsedContact.success) return { ok: false };
  const trimmedName = parsedName.data.trim();
  if (!trimmedName) return { ok: false };
  const name = await getProjectName(projectId);
  if (name === null) return { ok: false };

  const sql = getSql();
  const today = await hqToday();
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
    activityStmt(user.id, `Updated team on ${name}`),
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
  if (!id.safeParse(memberId).success) return { ok: false };
  const parsed = memberField.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid value." };
  const member = await getMemberProject(memberId);
  if (!member) return { ok: false };

  const sql = getSql();
  const today = await hqToday();
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
    activityStmt(user.id, `Updated team on ${member.projectName}`),
  ]);
  refreshHq();
  return { ok: true };
}

export async function removeProjectMember(memberId: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(memberId).success) return { ok: false };
  const member = await getMemberProject(memberId);
  if (!member) return { ok: false };

  const sql = getSql();
  const today = await hqToday();
  await sql.transaction([
    sql`DELETE FROM hq_project_members WHERE id = ${memberId}`,
    sql`
      UPDATE hq_projects SET touched_by_user_id = ${user.id}, touched_at = ${today}
      WHERE id = ${member.projectId}
    `,
    activityStmt(user.id, `Updated team on ${member.projectName}`),
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
  if (!id.safeParse(projectId).success) return { ok: false };
  const name = await getProjectName(projectId);
  if (name === null) return { ok: false };

  const sql = getSql();
  const today = await hqToday();
  const statusRows = await sql`SELECT id FROM hq_project_statuses WHERE slug = ${statusSlug}`;
  if (!statusRows[0]) return { ok: false };

  const statements = [
    sql`
      UPDATE hq_projects
      SET status_id = ${statusRows[0].id}, touched_by_user_id = ${user.id}, touched_at = ${today}
      WHERE id = ${projectId}
    `,
  ];
  if (!opts?.review) statements.push(activityStmt(user.id, `Set ${name} to ${statusSlug}`));
  await sql.transaction(statements);
  refreshHq();
  return { ok: true };
}

export async function setProjectForecast(
  projectId: string,
  forecastSlug: string,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(projectId).success) return { ok: false };
  const name = await getProjectName(projectId);
  if (name === null) return { ok: false };

  const sql = getSql();
  const today = await hqToday();
  const forecastRows = await sql`SELECT id FROM hq_project_forecasts WHERE slug = ${forecastSlug}`;
  if (!forecastRows[0]) return { ok: false };

  await sql.transaction([
    sql`
      UPDATE hq_projects
      SET forecast_id = ${forecastRows[0].id}, touched_by_user_id = ${user.id}, touched_at = ${today}
      WHERE id = ${projectId}
    `,
    activityStmt(user.id, `Moved ${name} to ${forecastSlug.replace("_", " ")}`),
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
  if (!id.safeParse(projectId).success || !id.safeParse(gateId).success) return { ok: false };
  const name = await getProjectName(projectId);
  if (name === null) return { ok: false };

  const sql = getSql();
  const today = await hqToday();
  const write = done
    ? sql`
        INSERT INTO hq_project_gates (project_id, gate_id) VALUES (${projectId}, ${gateId})
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
    activityStmt(user.id, `${done ? "Checked" : "Unchecked"} gate on ${name}`),
  ]);
  refreshHq();
  return { ok: true };
}

export async function saveProjectBlocker(
  projectId: string,
  blocker: string,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(projectId).success) return { ok: false };
  const parsed = text(500).safeParse(blocker);
  if (!parsed.success) return { ok: false };
  const name = await getProjectName(projectId);
  if (name === null) return { ok: false };

  const sql = getSql();
  const today = await hqToday();
  await sql.transaction([
    sql`
      UPDATE hq_projects
      SET blocker = ${parsed.data}, touched_by_user_id = ${user.id}, touched_at = ${today}
      WHERE id = ${projectId}
    `,
    activityStmt(user.id, `Updated blocker on ${name}`),
  ]);
  refreshHq();
  return { ok: true };
}

export async function addProjectNote(projectId: string, body: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(projectId).success) return { ok: false };
  const parsed = z.string().min(1).max(2000).safeParse(body);
  if (!parsed.success) return { ok: false };
  const name = await getProjectName(projectId);
  if (name === null) return { ok: false };

  const sql = getSql();
  const today = await hqToday();
  await sql.transaction([
    sql`
      INSERT INTO hq_project_notes (project_id, author_user_id, body)
      VALUES (${projectId}, ${user.id}, ${parsed.data})
    `,
    sql`
      UPDATE hq_projects SET touched_by_user_id = ${user.id}, touched_at = ${today}
      WHERE id = ${projectId}
    `,
    activityStmt(user.id, `Note on ${name}`),
  ]);
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
  if (!id.safeParse(noteId).success) return { ok: false };
  const parsed = z.string().min(1).max(2000).safeParse(body);
  if (!parsed.success) return { ok: false };

  const sql = getSql();
  const rows = await sql`
    SELECT p.id AS project_id, p.name
    FROM hq_project_notes n
    JOIN hq_projects p ON p.id = n.project_id
    WHERE n.id = ${noteId}
  `;
  const note = rows[0];
  if (!note) return { ok: false };

  const today = await hqToday();
  await sql.transaction([
    sql`
      UPDATE hq_project_notes SET body = ${parsed.data}, edited_at = now()
      WHERE id = ${noteId}
    `,
    sql`
      UPDATE hq_projects SET touched_by_user_id = ${user.id}, touched_at = ${today}
      WHERE id = ${note.project_id}
    `,
    activityStmt(user.id, `Edited note on ${note.name}`),
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
  if (!id.safeParse(projectId).success) return { ok: false };
  if (blocker !== undefined && !text(500).safeParse(blocker).success) return { ok: false };

  const sql = getSql();
  const rows = await sql`
    SELECT p.name, p.blocker, s.slug AS status_slug
    FROM hq_projects p
    JOIN hq_project_statuses s ON s.id = p.status_id
    WHERE p.id = ${projectId}
  `;
  const project = rows[0];
  if (!project) return { ok: false };

  const finalBlocker = blocker !== undefined ? blocker : project.blocker;
  const noteBody = `Monday review: ${project.status_slug}${
    finalBlocker ? `, blocker: ${finalBlocker}` : ", no blocker"
  }`;

  const today = await hqToday();
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
    activityStmt(user.id, `Monday review logged for ${project.name}`),
  ]);
  refreshHq();
  return { ok: true };
}
