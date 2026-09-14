/**
 * Actor-aware response shapes: the smallest DTO each audience may receive,
 * built by mapping from the row types the queries already return. Pure
 * types and mappers, no queries and no `server-only`, so a test can prove
 * what a member or Captain response carries and, more to the point, what it
 * does not.
 *
 * Operator-only shapes stay in ./types. A member or Captain surface renders
 * these views and nothing wider, so an operator field cannot reach a public
 * page by accident; it is never loaded and then hidden in the browser.
 */
import type { BuilderTeam, BuilderTeamSource, ProjectStage } from "./builder-types";
import type { Person } from "./types";

/**
 * The assigned Captain as a team may see them: a display name, and the
 * contact the Captain has approved for the teams they hold. Phase 6 gave
 * `contact` its writer: a Captain sets it on /hq/captain, and setting it is
 * itself the approval, which is why nothing else can fill this field and why
 * a login email or a profile address never does. Null while they have not
 * set one, and the team page then simply does not offer a way to reach them.
 */
export type TeamCaptainView = { displayName: string; contact: string | null };

/**
 * What a team member sees of their own team, and what the account that
 * submitted a still-unverified import sees of its own claim: the fields the
 * team page renders, and nothing from the operator side or from another
 * account's identity.
 */
export type MemberTeamView = {
  id: string;
  name: string;
  edition: { id: number; name: string };
  /** The viewer's own relationship with the team; no other account's identity is included. */
  membership: { role: "owner" | "member"; verification: BuilderTeam["verification"] };
  /** The team's current Captain, or null while none is assigned. */
  captain: TeamCaptainView | null;
  projectUrl: string;
  stage: ProjectStage;
  lead: { username: string };
  /**
   * The normalized Colosseum snapshot, the same shape every later view reads
   * (the plan's phase 3 handoff: "all later views use normalized project
   * information and a common submission-status service"). It is public
   * project information from Colosseum, carries no HQ notes and no account
   * id, and is safe for the team and its Captain alike.
   */
  source: BuilderTeamSource;
  /** The imported roster as the team page shows it. `id` is the roster row a team lead names when inviting; no account id is included. */
  roster: { id: string; name: string; username: string; avatarUrl: string | null; joined: boolean }[];
};

/** What an assigned Captain sees of a team: minimal contact and roster fields, no operator state. */
export type CaptainAssignmentView = {
  id: string;
  name: string;
  edition: { id: number; name: string };
  projectUrl: string;
  stage: ProjectStage;
  lead: { username: string };
  source: BuilderTeamSource;
  roster: { name: string; username: string; avatarUrl: string | null; joined: boolean }[];
};

/**
 * One row of the Captain leaderboard, which admins and Captains may see
 * (phase 4). Deliberately not a `CapabilityGrant`: that row carries the
 * admin's free-text `reason` for the grant, the `grantedByUserId` and
 * `revokedByUserId` operator ids, the grant id and the timestamps, none of
 * which a Captain may see about another Captain. The account id is left out
 * too, so a name on this page cannot be joined to an account.
 */
export type CaptainLeaderboardView = {
  rank: number;
  displayName: string;
  assignedCount: number;
  /**
   * Whether this row is the viewer's own, for "you" styling. Carries no
   * account id of its own: `toCaptainLeaderboardView` compares the row's
   * raw captain id against the viewer's id and keeps only the boolean, so
   * marking "you" never gives a Captain anything to join another Captain's
   * row to an account.
   */
  isYou: boolean;
};

/** A person as a public surface may show them: the name and the tag labels, never contact, org, notes or ids. */
export type PublicPersonView = {
  name: string;
  /**
   * The card's role tag, and the capability tags ("Captain") only on a
   * surface that asked for them. The permission contract shows Captain names
   * to Captains and operators alone, so they are left out by default.
   */
  tags: string[];
};

/**
 * Precondition: the viewer was already authorized on the team through
 * `authorizeProjectAction` (or the team came from a query scoped to their
 * account, such as `builderStore().teams(viewer.id)` or their own claim).
 * The mapper does not check membership; it derives `role: "member"` for any
 * viewer who is not the owner.
 */
export function toMemberTeamView(team: BuilderTeam, viewer: { id: string }, captain: TeamCaptainView | null = null): MemberTeamView {
  return {
    id: team.id,
    name: team.name,
    edition: { id: team.hackathonId, name: team.hackathonName },
    membership: { role: team.ownerId === viewer.id ? "owner" : "member", verification: team.verification },
    captain: captain ? { displayName: captain.displayName, contact: captain.contact } : null,
    projectUrl: team.projectUrl,
    stage: team.stage,
    lead: { username: team.leadUsername },
    source: team.source,
    roster: team.members.map((member) => ({ id: member.id, name: member.name, username: member.username, avatarUrl: member.avatarUrl, joined: member.joined })),
  };
}

export function toCaptainAssignmentView(team: BuilderTeam): CaptainAssignmentView {
  return {
    id: team.id,
    name: team.name,
    edition: { id: team.hackathonId, name: team.hackathonName },
    projectUrl: team.projectUrl,
    stage: team.stage,
    lead: { username: team.leadUsername },
    source: team.source,
    roster: team.members.map((member) => ({ name: member.name, username: member.username, avatarUrl: member.avatarUrl, joined: member.joined })),
  };
}

/**
 * One leaderboard row. `row.captainUserId` is compared against
 * `viewerUserId` to derive `isYou` and then discarded — it is the only place
 * a raw account id from `countAssignmentsByCaptain` or `listCapabilityGrants`
 * may appear on the way to this view, and it never reaches the returned
 * object. `viewerUserId` is null for a surface with no single viewer to mark
 * (the Admin leaderboard).
 */
export function toCaptainLeaderboardView(
  row: { captainUserId: string; displayName: string; assignedCount: number },
  rank: number,
  viewerUserId: string | null,
): CaptainLeaderboardView {
  return { rank, displayName: row.displayName, assignedCount: row.assignedCount, isYou: viewerUserId !== null && row.captainUserId === viewerUserId };
}

/**
 * Capability tags are dropped unless the caller opts in, so a surface that
 * forgets to think about its audience gets the safe shape. Pass
 * `{ includeCapabilities: true }` only where the permission contract allows
 * it: a Captain-only or operator page. Nothing else about the card changes.
 */
export function toPublicPersonView(person: Pick<Person, "name" | "tags">, options: { includeCapabilities?: boolean } = {}): PublicPersonView {
  const tags = options.includeCapabilities ? person.tags : person.tags.filter((tag) => tag.kind !== "capability");
  return { name: person.name, tags: tags.map((tag) => tag.label) };
}
