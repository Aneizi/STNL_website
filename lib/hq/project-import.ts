import "server-only";
import { ColosseumApiError, colosseumProjectUrl, fetchColosseumProject, type ColosseumErrorCode, type ColosseumFetch, type ImportedProject } from "@/lib/colosseum-api";
import { builderStore, type BuilderStore } from "./builder-store";
import {
  BuilderError, ImportRefusedError, isNetherlands, JOIN_LINK_MESSAGES,
  type BuilderHackathon, type BuilderIdentity, type ImportRefusal, type JoinProject, type JoinLinkRefusal,
} from "./builder-types";

/**
 * A verified account claims a roster entry from a Dutch project in the configured edition.
 * There is no external ownership proof or approval queue. Keep distinct refusal messages;
 * upstream error text remains diagnostic data and never reaches the member-facing response.
 */

/** Everything an import can be refused for. `ok` is the only success. */
export type ImportFailureReason =
  | ImportRefusal
  | "invalid_url"
  | "not_found"
  | "rate_limited"
  | "timed_out"
  | "unreachable"
  | "unreadable"
  | "source_error"
  | "unavailable";

type ImportOutcome =
  | { ok: true; projectId: string }
  | { ok: false; reason: ImportFailureReason; message: string };

type ImportPreviewOutcome =
  | { ok: true; project: { name: string; projectUrl: string; members: { username: string; name: string; avatarUrl: string | null }[] } }
  | { ok: false; reason: ImportFailureReason; message: string };

/** Preview carries source references only. No team, person or membership is created. */
export async function previewColosseumTeam(input: { hackathonId: number; url: string }, fetcher: ColosseumFetch = fetch): Promise<ImportPreviewOutcome> {
  const result = await importCandidate(builderStore(), input, fetcher);
  if (!result.ok) return result;
  const { project } = result;
  return { ok: true, project: { name: project.name, projectUrl: colosseumProjectUrl(project.slug),
    members: project.members.map(member => ({ username: member.username, name: member.displayName, avatarUrl: member.avatarUrl })) } };
}

/** Keep each source failure distinct without forwarding upstream error text. */
const API_REASONS: Record<ColosseumErrorCode, ImportFailureReason> = {
  INVALID_URL: "invalid_url",
  NOT_FOUND: "not_found",
  RATE_LIMITED: "rate_limited",
  TIMED_OUT: "timed_out",
  UNREACHABLE: "unreachable",
  INVALID_RESPONSE: "unreadable",
  SOURCE_REJECTED: "source_error",
  UNAVAILABLE: "unavailable",
  // Self-service applies its own edition gate; retain the adapter's distinct outcome.
  WRONG_HACKATHON: "wrong_edition",
};

export function importFailureFor(error: ColosseumApiError): { reason: ImportFailureReason; message: string } {
  return { reason: API_REASONS[error.code], message: error.message };
}

/** Drives the retry affordance without changing the failure message. */
export function inviteRetry(reason: ImportFailureReason): boolean {
  return ["rate_limited", "timed_out", "unreachable", "unreadable", "source_error", "unavailable"].includes(reason);
}

type EditionMapping = Pick<BuilderHackathon, "externalId" | "projectsOpen" | "projectsAvailableAt">;

/** Pure country/edition/availability gate over the fetched project. */
export function gateProject(
  project: { country: string | null; hackathon: { id: number } },
  edition: EditionMapping,
  now = Date.now(),
): ImportRefusal | null {
  if (edition.externalId == null) return "edition_not_configured";
  if (!edition.projectsOpen || (edition.projectsAvailableAt && Date.parse(edition.projectsAvailableAt) > now)) return "imports_closed";
  if (!isNetherlands(project.country)) return "not_dutch";
  if (project.hackathon.id !== edition.externalId) return "wrong_edition";
  return null;
}

/** The preview and commit share preflight; the store rechecks while holding its write locks. */
async function importCandidate(
  store: BuilderStore,
  input: { hackathonId: number; url: string },
  fetcher: ColosseumFetch,
): Promise<{ ok: true; project: ImportedProject } | Extract<ImportOutcome, { ok: false }>> {
  const edition = await store.hackathon(input.hackathonId);
  if (edition.externalId == null) return refusal("edition_not_configured");
  if (!edition.projectsOpen || (edition.projectsAvailableAt && Date.parse(edition.projectsAvailableAt) > Date.now())) {
    return refusal("imports_closed");
  }

  let project;
  try {
    project = await fetchColosseumProject(input.url, fetcher);
  } catch (error) {
    if (error instanceof ColosseumApiError) return { ok: false, ...importFailureFor(error) };
    throw error;
  }

  const refused = gateProject(project, edition);
  if (refused) return refusal(refused);

  // Read before write so the common case answers plainly. The unique
  // (hackathon_id, external_id) key inside importTeam is what makes the
  // simultaneous case safe; this read is what makes the ordinary one clear.
  if (await store.importedProject(input.hackathonId, project.externalId)) return refusal("already_imported");

  return { ok: true, project };
}

export async function importColosseumTeam(
  user: BuilderIdentity,
  input: { hackathonId: number; url: string; selectedUsername: string },
  fetcher: ColosseumFetch = fetch,
): Promise<ImportOutcome> {
  const store = builderStore();
  const result = await importCandidate(store, input, fetcher);
  if (!result.ok) return result;
  const { project } = result;

  try {
    const projectId = await store.importTeam(user, {
      hackathonId: input.hackathonId,
      project,
      projectUrl: colosseumProjectUrl(project.slug),
      selectedUsername: input.selectedUsername,
    });
    return { ok: true, projectId };
  } catch (error) {
    if (error instanceof ImportRefusedError) return refusal(error.reason);
    throw error;
  }
}

/** Attach a validated source to an existing HQ project, retaining ownership and history. */
export async function attachColosseumSource(
  input: { projectId: string; hackathonId: number; url: string; operatorId: string },
  fetcher: ColosseumFetch = fetch,
): Promise<ImportOutcome> {
  const store = builderStore();
  const edition = await store.hackathon(input.hackathonId);
  if (edition.externalId == null) return refusal("edition_not_configured");

  let project;
  try {
    project = await fetchColosseumProject(input.url, fetcher);
  } catch (error) {
    if (error instanceof ColosseumApiError) return { ok: false, ...importFailureFor(error) };
    throw error;
  }
  // `projectsOpen` is the self-service import window and is deliberately not
  // re-checked here: this is an operator attaching a source to a project HQ
  // already owns, not a new team entering through the public route.
  if (!isNetherlands(project.country)) return refusal("not_dutch");
  if (project.hackathon.id !== edition.externalId) return refusal("wrong_edition");
  if (await store.importedProject(input.hackathonId, project.externalId)) return refusal("already_imported");

  try {
    await store.attachSourceToProject({
      projectId: input.projectId,
      hackathonId: input.hackathonId,
      project,
      projectUrl: colosseumProjectUrl(project.slug),
      operatorId: input.operatorId,
    });
    return { ok: true, projectId: input.projectId };
  } catch (error) {
    if (error instanceof ImportRefusedError) return refusal(error.reason);
    if (error instanceof BuilderError) return { ok: false, reason: "unavailable", message: error.message };
    throw error;
  }
}

function refusal(reason: ImportRefusal): Extract<ImportOutcome, { ok: false }> {
  return { ok: false, reason, message: new ImportRefusedError(reason).message };
}

/** Refresh the roster behind a valid link before offering seats, including a previously full team. */
export async function previewTeamInvitation(code: string, fetcher: ColosseumFetch = fetch): Promise<
  { ok: true; data: JoinProject } | { ok: false; reason: JoinLinkRefusal | ImportFailureReason; message: string }
> {
  const store = builderStore();
  const invitation = await store.invitation(code);
  if (!invitation.ok) return { ...invitation, message: JOIN_LINK_MESSAGES[invitation.reason] };
  try {
    const project = await fetchColosseumProject(invitation.data.projectUrl, fetcher);
    await store.refreshTeam({ projectId: invitation.data.projectId, hackathonId: invitation.data.hackathonId, project, forJoining: true });
    const refreshed = await store.invitation(code);
    return refreshed.ok ? refreshed : { ...refreshed, message: JOIN_LINK_MESSAGES[refreshed.reason] };
  } catch (error) {
    if (error instanceof ColosseumApiError) return { ok: false, ...importFailureFor(error) };
    if (error instanceof ImportRefusedError) return refusal(error.reason);
    if (error instanceof BuilderError) return { ok: false, reason: 'unavailable', message: error.message };
    throw error;
  }
}

/** Refresh in place; failure preserves prior source data and records the failed attempt. */
export async function refreshColosseumTeam(
  input: { projectId: string; hackathonId: number; projectUrl: string },
  fetcher: ColosseumFetch = fetch,
): Promise<{ ok: true; submission: string } | { ok: false; reason: ImportFailureReason; message: string }> {
  const store = builderStore();
  try {
    const project = await fetchColosseumProject(input.projectUrl, fetcher);
    const submission = await store.refreshTeam({ projectId: input.projectId, hackathonId: input.hackathonId, project });
    return { ok: true, submission };
  } catch (error) {
    if (error instanceof ColosseumApiError) {
      await store.recordSourceFailure(input.projectId, error.code, error.sourceMessage);
      return { ok: false, ...importFailureFor(error) };
    }
    if (error instanceof BuilderError) {
      await store.recordSourceFailure(input.projectId, "SOURCE_MISMATCH", error.message);
      return { ok: false, reason: "unavailable", message: error.message };
    }
    throw error;
  }
}
