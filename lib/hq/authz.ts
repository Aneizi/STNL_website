import "server-only";
import { requireOperatorActor, type OperatorActor } from "./actor";

/**
 * Central authorization: the one module a caller looks in for a decision
 * about what an actor may do with a project or a reporting entry.
 *
 * The decisions themselves live in ./authz-decisions and are re-exported
 * here unchanged. That split is a module-graph decision, not a second
 * service: `requireOperator()` below is the only thing in this module that
 * reads a session, and its import of ./actor reaches ./member-auth, so a
 * service importing ./authz would pull the public member auth graph behind
 * it. ./reporting therefore imports ./authz-decisions, which keeps its
 * operator Server Actions clear of that graph
 * (tests/hq/operator-imports.test.ts). Everything else imports ./authz.
 *
 * Read ./authz-decisions for how each decision is made; nothing about the
 * rules changed when the file was split.
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

/** The operator gate as an actor: a thin wrapper over `requireUser()`. A public account never passes it. */
export async function requireOperator(): Promise<OperatorActor> {
  return requireOperatorActor();
}
