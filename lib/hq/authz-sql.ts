/**
 * Authorization facts are read fresh through the caller's database handle.
 * No sessions, caches or private pool: revocations apply on the next call.
 */
import type { BuilderQuery } from "./builder-db";
import { BuilderError } from "./builder-types";

/**
 * Reject missing records and edition mismatches identically to avoid revealing
 * records outside the selected edition.
 */
export function assertHackathonMatches<T extends { hackathonId: number }>(record: T | null | undefined, hackathonId: number): T {
  if (!record || record.hackathonId !== hackathonId) throw new BuilderError("This record is not available in the selected hackathon.");
  return record;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A record id that could be a row. Anything else is treated as not found instead of reaching the database. */
const isRecordId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/** The edition a project belongs to, from the core record. */
export type ProjectEdition = { projectId: string; hackathonId: number };

/**
 * Owners and joined roster members qualify only for verified imported teams.
 * Manual projects have no import claim to verify.
 */
export type TeamMembership = { projectId: string; hackathonId: number; role: "owner" | "member" };

/**
 * The project's current Captain.
 */
export type CurrentAssignment = { captainUserId: string };

/**
 * Shared entries are visible to the team; sensitive Captain notes are
 * restricted to their author and operators.
 */
export type EntryVisibility = "shared" | "sensitive";
export type Entry = {
  id: string;
  projectId: string;
  hackathonId: number;
  authorUserId: string;
  visibility: EntryVisibility;
};

export async function loadProjectEdition(db: BuilderQuery, projectId: string): Promise<ProjectEdition | null> {
  if (!isRecordId(projectId)) return null;
  const { rows } = await db.query("SELECT id::text AS project_id, hackathon_id FROM hq_projects WHERE id = $1::uuid", [projectId]);
  return rows.length ? { projectId: String(rows[0].project_id), hackathonId: Number(rows[0].hackathon_id) } : null;
}

/**
 * Prefer independent HQ ownership, falling back to the import owner for older
 * or externally inserted rows; joined roster rows also confer membership.
 * Imported claims must be verified. Manual projects have no claim state.
 * Return null without exposing project details when neither relationship holds.
 */
export async function loadTeamMembership(db: BuilderQuery, input: { userId: string; projectId: string }): Promise<TeamMembership | null> {
  if (!isRecordId(input.projectId)) return null;
  const { rows } = await db.query(
    `SELECT p.id::text AS project_id, p.hackathon_id,
       CASE WHEN COALESCE(w.owner_user_id, o.owner_user_id) = $1 THEN 'owner' ELSE 'member' END AS role
     FROM hq_projects p
     LEFT JOIN hq_project_ownership w ON w.project_id = p.id
     LEFT JOIN hq_project_onboarding o ON o.project_id = p.id
     WHERE p.id = $2::uuid AND (o.project_id IS NULL OR o.verification = 'verified')
       AND (COALESCE(w.owner_user_id, o.owner_user_id) = $1
         OR EXISTS (SELECT 1 FROM hq_project_members m WHERE m.project_id = p.id AND m.builder_user_id = $1))`,
    [input.userId, input.projectId],
  );
  if (!rows.length) return null;
  return { projectId: String(rows[0].project_id), hackathonId: Number(rows[0].hackathon_id), role: rows[0].role === "owner" ? "owner" : "member" };
}

type AssignmentLoader = (db: BuilderQuery, projectId: string) => Promise<CurrentAssignment | null>;
type EntryLoader = (db: BuilderQuery, entryId: string) => Promise<Entry | null>;

/**
 * Only unended assignments with a surviving account are current. Account
 * deletion preserves assignment history through ON DELETE SET NULL.
 */
export const loadCurrentAssignment: AssignmentLoader = async (db, projectId) => {
  if (!isRecordId(projectId)) return null;
  const { rows } = await db.query(
    "SELECT captain_user_id FROM hq_captain_assignments WHERE project_id = $1::uuid AND unassigned_at IS NULL AND captain_user_id IS NOT NULL",
    [projectId],
  );
  return rows.length ? { captainUserId: String(rows[0].captain_user_id) } : null;
};

/**
 * Derive the edition from the project. Prefix operator author ids to prevent
 * collisions with member ids from granting author-only access.
 * Return voided entries too: moderation restrictions belong to the service.
 */
export const loadEntry: EntryLoader = async (db, entryId) => {
  if (!isRecordId(entryId)) return null;
  const { rows } = await db.query(
    `SELECT e.id::text AS id, e.project_id::text AS project_id, p.hackathon_id, e.author_kind, e.author_id, e.visibility
     FROM hq_reporting_entries e JOIN hq_projects p ON p.id = e.project_id
     WHERE e.id = $1::uuid`,
    [entryId],
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    hackathonId: Number(row.hackathon_id),
    authorUserId: row.author_kind === "operator" ? `operator:${String(row.author_id)}` : String(row.author_id),
    visibility: row.visibility === "sensitive" ? "sensitive" : "shared",
  };
};
