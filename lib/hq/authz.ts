import "server-only";
import { requireOperatorActor, type Actor, type OperatorActor } from "./actor";
import {
  loadCurrentAssignment,
  loadProjectEdition,
  loadTeamMembership,
  type CurrentAssignment,
  type Entry,
  type ProjectEdition,
  type TeamMembership,
} from "./authz-sql";
import { builderDatabase, type BuilderQuery } from "./builder-db";
import { BuilderError } from "./builder-types";
import { listActiveCapabilities, type Capability } from "./capabilities";

export type { CurrentAssignment, Entry, EntryVisibility, ProjectEdition, TeamMembership } from "./authz-sql";
export { loadCurrentAssignment, loadEntry } from "./authz-sql";

/**
 * Central authorization: every decision about what an actor may do with a
 * project or a reporting entry is made here, over facts read fresh for the
 * call. Nothing is cached across calls, so a revoked grant, a removed
 * membership or a changed assignment takes effect on the next protected
 * request, whatever a cookie or an earlier page said.
 *
 * Operators have full access, and only through `kind: "operator"`: no
 * capability, role, tag or tier of a public account reaches this branch. A
 * member is evaluated per resource: team membership first (a Captain who is
 * also on a team keeps that team's ordinary permissions), then the Captain
 * capability together with the current assignment. The capability on its own
 * opens nothing.
 *
 * To a member, a project they have no relationship with looks exactly like
 * one that does not exist (`not_found`), whether it is missing, in another
 * edition or simply someone else's. `wrong_edition` is only ever returned to
 * an actor who is related to the project and asked for it under a different
 * edition, for example through a stale cookie or a crafted body.
 */

export type ProjectAction = "read" | "update.create" | "update.edit" | "membership.change" | "assignment.read";

export type Authorization =
  | { allowed: true; via: "operator" | "member" | "captain" }
  | {
      allowed: false;
      /**
       * `not_found`: no project the actor may know about. `wrong_edition`:
       * related, but not under this edition. `not_member`: related, but the
       * action needs a team relationship the actor lacks (the team lead for
       * membership changes; Captains hold no Captain-only permission there).
       * `not_assigned`: holds `captain`, is not the project's current Captain.
       * `no_capability`: the actor kind has no project access at all (a job).
       * `not_author`: reserved for entry edits by someone other than the author.
       */
      reason: "not_member" | "not_assigned" | "wrong_edition" | "not_found" | "no_capability" | "not_author";
    };

export type ProjectActionRequest = { projectId: string; hackathonId: number; action: ProjectAction };

/**
 * The facts a decision reads. Defaults hit the builder-side database; tests
 * and later phases inject the ones they need. Every call builds its own set,
 * so nothing survives from one request to the next.
 */
export type AuthzLoaders = {
  loadProjectEdition(projectId: string): Promise<ProjectEdition | null>;
  loadTeamMembership(input: { userId: string; projectId: string }): Promise<TeamMembership | null>;
  loadCapabilities(userId: string): Promise<readonly Capability[]>;
  loadCurrentAssignment(projectId: string): Promise<CurrentAssignment | null>;
};

function withDefaults(overrides?: Partial<AuthzLoaders>): AuthzLoaders {
  let handle: BuilderQuery | undefined;
  const db = () => (handle ??= builderDatabase());
  return {
    loadProjectEdition: (projectId) => loadProjectEdition(db(), projectId),
    loadTeamMembership: (input) => loadTeamMembership(db(), input),
    loadCapabilities: (userId) => listActiveCapabilities(userId, db()),
    loadCurrentAssignment: (projectId) => loadCurrentAssignment(db(), projectId),
    ...overrides,
  };
}

/** What a team relationship allows: every action, except that only the team lead changes the membership. */
const TEAM_LEAD_ONLY: ReadonlySet<ProjectAction> = new Set(["membership.change"]);
/** What an assignment allows: the shared reporting surface and the assignment itself, never the team's membership. */
const CAPTAIN_ACTIONS: ReadonlySet<ProjectAction> = new Set(["read", "update.create", "update.edit", "assignment.read"]);

/** The operator gate as an actor: a thin wrapper over `requireUser()`. A public account never passes it. */
export async function requireOperator(): Promise<OperatorActor> {
  return requireOperatorActor();
}

/** The actor's active capabilities, read at call time. Operators and jobs hold none: their access is their kind. */
export async function getActorCapabilities(actor: Actor, overrides?: Partial<AuthzLoaders>): Promise<ReadonlySet<Capability>> {
  if (actor.kind !== "member") return new Set();
  return new Set(await withDefaults(overrides).loadCapabilities(actor.id));
}

export async function authorizeProjectAction(actor: Actor, request: ProjectActionRequest, overrides?: Partial<AuthzLoaders>): Promise<Authorization> {
  if (actor.kind === "operator") return { allowed: true, via: "operator" };
  if (actor.kind !== "member") return { allowed: false, reason: "no_capability" };
  const load = withDefaults(overrides);
  const edition = await load.loadProjectEdition(request.projectId);
  if (!edition) return { allowed: false, reason: "not_found" };

  const membership = await load.loadTeamMembership({ userId: actor.id, projectId: request.projectId });
  if (membership) {
    if (edition.hackathonId !== request.hackathonId) return { allowed: false, reason: "wrong_edition" };
    if (TEAM_LEAD_ONLY.has(request.action) && membership.role !== "owner") return { allowed: false, reason: "not_member" };
    return { allowed: true, via: "member" };
  }

  const capabilities = await load.loadCapabilities(actor.id);
  if (!capabilities.includes("captain")) return { allowed: false, reason: "not_found" };
  const assignment = await load.loadCurrentAssignment(request.projectId);
  if (assignment?.captainUserId !== actor.id) return { allowed: false, reason: "not_assigned" };
  if (edition.hackathonId !== request.hackathonId) return { allowed: false, reason: "wrong_edition" };
  if (!CAPTAIN_ACTIONS.has(request.action)) return { allowed: false, reason: "not_member" };
  return { allowed: true, via: "captain" };
}

/** A verified owner or joined roster member of the project. Only a member actor can be one. */
export async function isTeamMember(actor: Actor, projectId: string, overrides?: Partial<AuthzLoaders>): Promise<boolean> {
  if (actor.kind !== "member") return false;
  return (await withDefaults(overrides).loadTeamMembership({ userId: actor.id, projectId })) !== null;
}

/** The project's current Captain: holds the `captain` capability right now and is the current assignee. */
export async function isAssignedCaptain(actor: Actor, projectId: string, overrides?: Partial<AuthzLoaders>): Promise<boolean> {
  if (actor.kind !== "member") return false;
  const load = withDefaults(overrides);
  if (!(await load.loadCapabilities(actor.id)).includes("captain")) return false;
  return (await load.loadCurrentAssignment(projectId))?.captainUserId === actor.id;
}

export type EntryAudience = "none" | "read" | "read_write";

/**
 * What the actor may do with one reporting entry, per the permission
 * contract. Shared entries: the team and the assigned Captain read them, the
 * author edits their own while still authorized on the project. Sensitive
 * notes: the author and operators only; the author keeps a read-only view
 * while their Captain capability is active, and editing again requires
 * current project authorization. Everyone else, including another Captain
 * and the team, gets nothing, not even the note's existence.
 */
export async function entryAudience(entry: Entry, actor: Actor, overrides?: Partial<AuthzLoaders>): Promise<EntryAudience> {
  if (actor.kind === "operator") return "read_write";
  if (actor.kind !== "member") return "none";
  const author = entry.authorUserId === actor.id;
  const access = await authorizeProjectAction(
    actor,
    { projectId: entry.projectId, hackathonId: entry.hackathonId, action: author ? "update.edit" : "read" },
    overrides,
  );
  if (entry.visibility === "shared") return access.allowed ? (author ? "read_write" : "read") : "none";
  if (!author) return "none";
  if (access.allowed) return "read_write";
  // `not_assigned` is only ever returned to a member who holds `captain`: the
  // author-only view of a reassigned Captain whose capability is still active.
  return access.reason === "not_assigned" ? "read" : "none";
}

/** Operators edit anything; a member edits only their own entry, and only while authorized on its project. */
export async function canEditEntry(actor: Actor, entry: Entry, overrides?: Partial<AuthzLoaders>): Promise<boolean> {
  return (await entryAudience(entry, actor, overrides)) === "read_write";
}

/** Revision history is operator-only. A member, an author included, never sees prior versions. */
export function canReadRevisionHistory(actor: Actor): boolean {
  return actor.kind === "operator";
}

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
