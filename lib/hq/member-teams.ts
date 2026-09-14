import "server-only";
import type { MemberActor } from "./actor";
import { authorizeProjectAction, type ProjectAction } from "./authz";
import { loadProjectEdition } from "./authz-sql";
import { builderDatabase } from "./builder-db";
import { builderStore } from "./builder-store";
import type { BuilderTeam } from "./builder-types";
import { currentCaptainOfProject } from "./captains";
import { readCaptainContact } from "./reporting-contacts";
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
 * The team page's read: the team as its verified member may see it, or, for
 * the account that submitted an import still awaiting or refused review, that
 * account's own claim with its status. The claim is read by account, like the
 * dashboard's import requests; it authorizes nothing on the project, so a
 * claimant can neither invite nor edit until the team is verified.
 */
export async function memberTeamView(actor: MemberActor, projectId: string): Promise<MemberTeamView | null> {
  const outcome = await decide(actor, { projectId, action: "read" });
  if (outcome === "missing") return null;
  const store = builderStore();
  const team = outcome === "allowed" ? await store.teamById(projectId) : await store.ownClaim(actor.id, projectId);
  if (!team) return null;
  // Only the verified team sees its Captain, never the account watching its
  // own still-pending or rejected claim: it is not confirmed as this
  // project's team yet, so there is nothing for it to be "its own Captain".
  const captain = outcome === "allowed" ? await currentCaptainOfProject(builderDatabase(), projectId) : null;
  // The contact the Captain approved for the teams they hold, or null when
  // they have not set one. Phase 6 gave that field its writer (/hq/captain);
  // before it there was none, which is why it read null for everyone.
  const contact = captain ? await readCaptainContact(builderDatabase(), captain.captainUserId) : null;
  return toMemberTeamView(team, actor, captain ? { displayName: captain.captainName, contact } : null);
}
