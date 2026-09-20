import "server-only";

/**
 * Session-free public entry point for authorization decisions and types.
 * Implementations live in authz-decisions; neither module loads member auth.
 */

export type {
  Authorization,
  AuthzLoaders,
  CurrentAssignment,
  Entry,
  EntryAudience,
  EntryVisibility,
  ProjectAction,
  ProjectActionRequest,
  ProjectEdition,
  TeamMembership,
} from "./authz-decisions";
export {
  assertHackathonMatches,
  authorizeProjectAction,
  canEditEntry,
  canReadRevisionHistory,
  entryAudience,
  getActorCapabilities,
  isAssignedCaptain,
  isTeamMember,
  loadCurrentAssignment,
  loadEntry,
} from "./authz-decisions";
