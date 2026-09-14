/**
 * Pure loaders for the authorization module (./authz): the facts a decision
 * is made over, read fresh from the database handle they are given. No
 * `server-only`, no pool of their own and no caching, so tests can drive
 * them against a throwaway Postgres and a revocation is visible on the very
 * next call.
 *
 * Two of the loaders are typed hooks for records a later phase creates:
 * `loadCurrentAssignment` (Captain assignment, phase 4, reads
 * hq_captain_assignments as of task T4.1) and `loadEntry` (reporting entry,
 * phase 5, still a stub). Their signatures and result types were fixed
 * before either table existed, the decision logic over them in ./authz is
 * tested with injected fixtures, and each phase only replaces the body.
 *
 * `assertHackathonMatches` lives here rather than in ./authz because it reads
 * no session: every operator action module reaches it through
 * ./actions/util.ts, and importing it from ./authz would pull the member auth
 * graph into the operator bundles (tests/hq/operator-imports.test.ts).
 */
import type { BuilderQuery } from "./builder-db";
import { BuilderError } from "./builder-types";

/**
 * For actions that take a record id and the edition they run in: the record
 * must exist and belong to that edition, or the action stops. A missing
 * record and one from another edition fail the same way, so an id from a
 * request body reveals nothing about records outside the actor's edition.
 */
export function assertHackathonMatches<T extends { hackathonId: number }>(record: T | null | undefined, hackathonId: number): T {
  if (!record || record.hackathonId !== hackathonId) throw new BuilderError("This record is not available in the selected hackathon.");
  return record;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A project id that could be a row. Anything else is treated as not found instead of reaching the database. */
const isProjectId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/** The edition a project belongs to, from the core record. */
export type ProjectEdition = { projectId: string; hackathonId: number };

/**
 * An account's verified relationship with a project's team. Only a verified
 * project counts: an owner or roster member of a pending or rejected claim
 * has no membership. `owner` is the verified account that claimed the
 * project, the team lead in HQ; `member` is a joined roster row.
 */
export type TeamMembership = { projectId: string; hackathonId: number; role: "owner" | "member" };

/** The one current Captain of a project. Phase 4 record. */
export type CurrentAssignment = { captainUserId: string };

/**
 * A reporting entry as the audience rules see it. Phase 5 record. `shared`
 * is a team update or a Captain note the team may read; `sensitive` is a
 * Captain note restricted to its author and operators.
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
  if (!isProjectId(projectId)) return null;
  const { rows } = await db.query("SELECT id::text AS project_id, hackathon_id FROM hq_projects WHERE id = $1::uuid", [projectId]);
  return rows.length ? { projectId: String(rows[0].project_id), hackathonId: Number(rows[0].hackathon_id) } : null;
}

/**
 * The account's verified membership of the project, or null. Checked per
 * call against `hq_project_onboarding` (owner, verification) and
 * `hq_project_members` (joined roster rows); nothing about the project is
 * revealed when there is no membership.
 */
export async function loadTeamMembership(db: BuilderQuery, input: { userId: string; projectId: string }): Promise<TeamMembership | null> {
  if (!isProjectId(input.projectId)) return null;
  const { rows } = await db.query(
    `SELECT o.project_id::text AS project_id, p.hackathon_id,
       CASE WHEN o.owner_user_id = $1 THEN 'owner' ELSE 'member' END AS role
     FROM hq_project_onboarding o JOIN hq_projects p ON p.id = o.project_id
     WHERE o.project_id = $2::uuid AND o.verification = 'verified'
       AND (o.owner_user_id = $1
         OR EXISTS (SELECT 1 FROM hq_project_members m WHERE m.project_id = o.project_id AND m.builder_user_id = $1))`,
    [input.userId, input.projectId],
  );
  if (!rows.length) return null;
  return { projectId: String(rows[0].project_id), hackathonId: Number(rows[0].hackathon_id), role: rows[0].role === "owner" ? "owner" : "member" };
}

export type AssignmentLoader = (db: BuilderQuery, projectId: string) => Promise<CurrentAssignment | null>;
export type EntryLoader = (db: BuilderQuery, entryId: string) => Promise<Entry | null>;

/**
 * The project's current Captain from hq_captain_assignments, or null.
 * `unassigned_at IS NULL` is what "current" means; `captain_user_id IS NOT
 * NULL` guards the rare case where the assignment's account was deleted
 * (that column is ON DELETE SET NULL so the row survives as history), so an
 * orphaned row is never read back as a live assignment.
 */
export const loadCurrentAssignment: AssignmentLoader = async (db, projectId) => {
  if (!isProjectId(projectId)) return null;
  const { rows } = await db.query(
    "SELECT captain_user_id FROM hq_captain_assignments WHERE project_id = $1::uuid AND unassigned_at IS NULL AND captain_user_id IS NOT NULL",
    [projectId],
  );
  return rows.length ? { captainUserId: String(rows[0].captain_user_id) } : null;
};

// TODO(phase 5): read the entry from the reporting entry table once phase 5
// creates it. Until then there are no entries to authorize.
export const loadEntry: EntryLoader = async () => null;
