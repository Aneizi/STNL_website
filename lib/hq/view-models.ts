/**
 * Audience-specific DTOs keep operator data and account identities out of
 * member responses. Pure mappers; callers authorize before mapping.
 */
import type { BuilderTeam, BuilderTeamSource, ProjectStage } from "./builder-types";

/**
 * Captain name and approved contact: linked Telegram username, then the saved
 * Captain contact, or null. Never expose a login email or profile address.
 */
type TeamCaptainView = { displayName: string; contact: string | null };

/**
 * Member-safe team data, also shown to the submitter of an unverified claim.
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
   * Public Colosseum project data, with no HQ notes or account ids.
   */
  source: BuilderTeamSource;
  /** Colosseum reference entries. The team page lists joined accounts only; no account id is included. */
  roster: { id: string; name: string; username: string; avatarUrl: string | null; joined: boolean }[];
};

/**
 * Caller must authorize the viewer or load the team through an account-scoped
 * query. This mapper assumes non-owners are members; it does not check access.
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
