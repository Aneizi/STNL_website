/**
 * Pure loaders for the authorization module (./authz): the facts a decision
 * is made over, read fresh from the database handle they are given. No
 * `server-only`, no pool of their own and no caching, so tests can drive
 * them against a throwaway Postgres and a revocation is visible on the very
 * next call.
 *
 * Two of the loaders were typed hooks for records a later phase created:
 * `loadCurrentAssignment` (Captain assignment, reads hq_captain_assignments
 * since task T4.1) and `loadEntry` (reporting entry, reads
 * hq_reporting_entries since task T5.2). Their signatures and result types
 * were fixed before either table existed, the decision logic over them in
 * ./authz is tested with injected fixtures, and each phase replaced only the
 * body — neither needed a change to `Entry`, `CurrentAssignment`,
 * `entryAudience` or `canEditEntry`, which is what the injected-fixture
 * approach was for.
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

/** A record id that could be a row. Anything else is treated as not found instead of reaching the database. */
const isRecordId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

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
  if (!isRecordId(projectId)) return null;
  const { rows } = await db.query("SELECT id::text AS project_id, hackathon_id FROM hq_projects WHERE id = $1::uuid", [projectId]);
  return rows.length ? { projectId: String(rows[0].project_id), hackathonId: Number(rows[0].hackathon_id) } : null;
}

/**
 * The account's membership of the project, or null. Nothing about the project
 * is revealed when there is no membership.
 *
 * Two sources, checked per call:
 *
 * - `hq_project_ownership`, the HQ owner, falling back to
 *   `hq_project_onboarding.owner_user_id` where there is no ownership row.
 *   The onboarding row cannot exist without a Colosseum `external_id`, so
 *   ownership of a project an admin created by hand from a help request had
 *   nowhere to live and its builders had no way into it at all (the plan's
 *   "Model HQ project ownership independently of a successful external
 *   snapshot"). Existing importers were backfilled into the new table and
 *   `importTeam` writes it alongside the onboarding row, so an imported
 *   team's owner is unchanged; the COALESCE is what makes that true even for
 *   an onboarding row written by something other than `importTeam`, such as a
 *   seed or a fixture, rather than stranding its owner.
 * - `hq_project_members`, a joined roster row, as before.
 *
 * `verification` still decides for an IMPORTED project: an owner or roster
 * member of a claim that is pending or rejected has no membership, which is
 * the window `checkCaptainConflict` in ./captains.ts covers separately. A
 * project with no onboarding row has no claim to verify and is not held to a
 * verification state it can never have.
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
  if (!isRecordId(projectId)) return null;
  const { rows } = await db.query(
    "SELECT captain_user_id FROM hq_captain_assignments WHERE project_id = $1::uuid AND unassigned_at IS NULL AND captain_user_id IS NOT NULL",
    [projectId],
  );
  return rows.length ? { captainUserId: String(rows[0].captain_user_id) } : null;
};

/**
 * The reporting entry an audience decision is made about, or null.
 *
 * The edition comes from the project rather than from a column of the
 * entry's own, so an entry can never claim an edition its project is not in.
 *
 * `authorUserId` is the entry's `author_id` for a member author and
 * `operator:<id>` for an operator one. The two author spaces are different
 * tables (`hq_builder_profiles.id`, a text id from the login provider, and
 * `hq_users.id`, a uuid), and the only reader of this field compares it
 * against a *member* actor's id to decide the author-only rules in ./authz.
 * Namespacing the operator side means an admin-authored sensitive note can
 * never be read as a member's own, however the two id spaces happen to
 * overlap. A voided entry is still returned: voiding is moderation, not
 * deletion, and whether an edit is refused for that reason belongs to the
 * reporting service, not to an authorization fact.
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
