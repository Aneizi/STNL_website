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
  // Mirrors the design: new projects start green/likely with the lead as
  // the first team member.
  await sql.transaction([
    sql`
      INSERT INTO hq_projects
        (name, lead_name, lead_contact, members, partner_id, event_src,
         status_id, forecast_id, last_check_in, touched_by_user_id, touched_at)
      VALUES
        (${name}, ${leadName}, ${leadContact},
         ${leadName ? [leadName] : []}::text[], ${partnerId}, ${eventSrc},
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
  z.object({ field: z.literal("members"), value: text(1000) }),
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
    case "members": {
      const members = data.value.split(",").map((s) => s.trim()).filter(Boolean);
      update = sql`UPDATE hq_projects SET members = ${members}::text[] WHERE id = ${projectId}`;
      message = `Updated team on ${name}`;
      break;
    }
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
