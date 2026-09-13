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
import type { BuilderTeam, ProjectStage } from "./builder-types";
import type { Person } from "./types";

/** The assigned Captain as a team may see them: a display name and the contact the Captain approved for the team, nothing else. */
export type TeamCaptainView = { displayName: string; contact: string | null };

/** What a verified team member sees of their own team. */
export type MemberTeamView = {
  id: string;
  name: string;
  edition: { id: number; name: string };
  /** The viewer's own relationship with the team; no other account's identity is included. */
  membership: { role: "owner" | "member"; verification: BuilderTeam["verification"] };
  /** Null until phase 4 assigns Captains. */
  captain: TeamCaptainView | null;
};

/** What an assigned Captain sees of a team: minimal contact and roster fields, no operator state. */
export type CaptainAssignmentView = {
  id: string;
  name: string;
  edition: { id: number; name: string };
  projectUrl: string;
  stage: ProjectStage;
  lead: { username: string };
  roster: { name: string; username: string; joined: boolean }[];
};

/** A person as a public surface may show them: the name and the tag labels, never contact, org, notes or ids. */
export type PublicPersonView = { name: string; tags: string[] };

export function toMemberTeamView(team: BuilderTeam, viewer: { id: string }, captain: TeamCaptainView | null = null): MemberTeamView {
  return {
    id: team.id,
    name: team.name,
    edition: { id: team.hackathonId, name: team.hackathonName },
    membership: { role: team.ownerId === viewer.id ? "owner" : "member", verification: team.verification },
    captain: captain ? { displayName: captain.displayName, contact: captain.contact } : null,
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
    roster: team.members.map((member) => ({ name: member.name, username: member.username, joined: member.joined })),
  };
}

export function toPublicPersonView(person: Pick<Person, "name" | "tags">): PublicPersonView {
  return { name: person.name, tags: person.tags.map((tag) => tag.label) };
}
