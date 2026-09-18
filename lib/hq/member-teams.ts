import "server-only";
import type { MemberActor } from "./actor";
import { authorizeProjectAction, type ProjectAction } from "./authz";
import { loadProjectEdition, loadTeamMembership } from "./authz-sql";
import { builderDatabase } from "./builder-db";
import { builderStore } from "./builder-store";
import type { BuilderTeam } from "./builder-types";
import { currentCaptainOfProject } from "./captains";
import { readCaptainHandle } from "./reporting-contacts";
import { toMemberTeamView, type MemberTeamView } from "./view-models";

/**
 * Member-facing team reads over the central authorization helper: the
 * decision first, the row only once it allows. This is the store call the
 * team page and the team actions share. It sits beside the store rather than
 * in it because builder-store.ts is imported by member-auth.ts, which the
 * actor and authorization modules depend on, so the store cannot import
 * ./authz without a cycle.
 *
 * Every denial is the same answer, null, whatever the reason. A foreign
 * team, one in another edition, a pending claim, an unknown id and a
 * malformed id all look like a missing team to the member, and the reason
 * never reaches a response. The `hq_hackathon` cookie is never read here:
 * the edition a member asks under comes from the request, or is the
 * project's own.
 */

/** The one message every member-facing denial shows. Identical for a missing, foreign, other-edition and not-owned team. */
export const TEAM_NOT_AVAILABLE = "This team is not available to your account.";

type TeamRequest = { projectId: string; hackathonId?: number; action: ProjectAction };

/**
 * The central decision for one team. `hackathonId` is the edition the
 * member asked under, from the request body; on a URL read there is none
 * and the project's own edition stands in, so the check is on the
 * relationship alone.
 */
async function decide(actor: MemberActor, request: TeamRequest): Promise<"allowed" | "denied" | "missing"> {
  const edition = await loadProjectEdition(builderDatabase(), request.projectId);
  if (!edition) return "missing";
  const decision = await authorizeProjectAction(
    actor,
    { projectId: request.projectId, hackathonId: request.hackathonId ?? edition.hackathonId, action: request.action },
    { loadProjectEdition: async () => edition },
  );
  return decision.allowed ? "allowed" : "denied";
}

/** The team when the decision allows `action` for this actor, else null. */
export async function authorizedTeam(actor: MemberActor, request: TeamRequest): Promise<BuilderTeam | null> {
  return (await decide(actor, request)) === "allowed" ? builderStore().teamById(request.projectId) : null;
}

/**
 * An HQ project with no Colosseum snapshot behind it, as its own member may
 * see it: an operator created it from a Request help submission, so it has a
 * name, an edition and a Captain, and no roster, project link or submission
 * status because it genuinely has none yet.
 *
 * Separate from `memberTeamView` rather than a nullable version of it. The
 * decision is the same one (`authorizeProjectAction`, which now reads HQ
 * ownership), and what differs is only what there is to show.
 */
export type MemberProjectView = {
  id: string;
  name: string;
  edition: { id: number; name: string };
  membership: { role: "owner" | "member" };
  captain: { displayName: string; contact: string | null } | null;
};

export async function memberProjectView(actor: MemberActor, projectId: string): Promise<MemberProjectView | null> {
  if ((await decide(actor, { projectId, action: "read" })) !== "allowed") return null;
  const db = builderDatabase();
  const project = await builderStore().projectById(projectId);
  if (!project) return null;
  const membership = await loadTeamMembership(db, { userId: actor.id, projectId });
  const captain = await currentCaptainOfProject(db, projectId);
  const contact = captain ? await readCaptainHandle(db, captain.captainUserId) : null;
  return {
    id: project.id,
    name: project.name,
    edition: { id: project.hackathonId, name: project.hackathonName },
    membership: { role: membership?.role ?? "member" },
    captain: captain ? { displayName: captain.captainName, contact } : null,
  };
}

/** The imported team after its current membership or Captain access is authorized. */
export async function memberTeamView(actor: MemberActor, projectId: string): Promise<MemberTeamView | null> {
  if ((await decide(actor, { projectId, action: "read" })) !== "allowed") return null;
  const team = await builderStore().teamById(projectId);
  if (!team) return null;
  const captain = await currentCaptainOfProject(builderDatabase(), projectId);
  // The Captain's Telegram handle, or the contact they typed before the Den
  // stopped taking one, or null: the same source the Den itself shows them.
  const contact = captain ? await readCaptainHandle(builderDatabase(), captain.captainUserId) : null;
  return toMemberTeamView(team, actor, captain ? { displayName: captain.captainName, contact } : null);
}
