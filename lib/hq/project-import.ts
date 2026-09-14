import "server-only";
import { ColosseumApiError, fetchColosseumProject, type ColosseumErrorCode, type ColosseumFetch } from "@/lib/colosseum-api";
import { builderStore } from "./builder-store";
import {
  BuilderError, ImportRefusedError, isNetherlands,
  type BuilderIdentity, type ImportRefusal,
} from "./builder-types";

/**
 * Self-service team import, and the one place its failure taxonomy lives.
 *
 * Owner change of 14 September 2026 (`docs/plans/2026-09-13-hq-captains-and-colosseum.md`,
 * section 2 "Team import and joining" and phase 3 "The import gate, joining
 * and error reporting"): an import is accepted when, and only when, the
 * fetched project is a Netherlands project AND its `hackathonId` equals the
 * external edition id an admin configured in `hq_hackathon_onboarding`. There
 * is no ownership proof, no pending state and no approval queue.
 *
 * Neither gate value is ever hard coded. The country string is the plan's own
 * (`lib/hq/builder-types.ts#NETHERLANDS`); the external edition id is
 * operator data, read at runtime, never seeded.
 *
 * **Every failure has its own outcome.** The plan is explicit that "no failure
 * collapses into a generic 'could not import'", so `ImportOutcome` below
 * carries one `reason` per case and the screen answers each differently — in
 * particular "already imported" routes the person to help rather than to a
 * retry, and the transport failures invite a retry rather than implying the
 * project does not exist.
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

export type ImportOutcome =
  | { ok: true; projectId: string }
  | { ok: false; reason: ImportFailureReason; message: string };

/**
 * One Colosseum transport/lookup failure, mapped to its own outcome. This is
 * the seam that used to collapse: the adapter now distinguishes a 404, a
 * timeout, an unreachable host, a 429, an unreadable body and a 4xx whose
 * body carries Colosseum's own `code`/`message`, and each keeps its own
 * reason and its own wording here.
 *
 * The external `message` is deliberately NOT forwarded to the browser: it is
 * upstream text HQ does not control, and the plan forbids rendering it as
 * markup. It is stored on the project's snapshot for operators instead
 * (`source_error_message`), where the error belongs to a project.
 */
const API_REASONS: Record<ColosseumErrorCode, ImportFailureReason> = {
  INVALID_URL: "invalid_url",
  NOT_FOUND: "not_found",
  RATE_LIMITED: "rate_limited",
  TIMED_OUT: "timed_out",
  UNREACHABLE: "unreachable",
  INVALID_RESPONSE: "unreadable",
  SOURCE_REJECTED: "source_error",
  UNAVAILABLE: "unavailable",
  // The self-service gate answers a wrong edition itself, with its own
  // message; this mapping exists so the union is total, not because
  // assertProjectHackathon is on the import path.
  WRONG_HACKATHON: "wrong_edition",
};

export function importFailureFor(error: ColosseumApiError): { reason: ImportFailureReason; message: string } {
  return { reason: API_REASONS[error.code], message: error.message };
}

/**
 * Whether the person should be invited to try again, as opposed to told
 * something about their project or their link. Drives the retry affordance,
 * never the wording.
 */
export function inviteRetry(reason: ImportFailureReason): boolean {
  return ["rate_limited", "timed_out", "unreachable", "unreadable", "source_error", "unavailable"].includes(reason);
}

export type EditionMapping = { hackathonId: number; externalId: number | null; externalSlug: string | null; projectsOpen: boolean; projectsAvailableAt: string | null };

/**
 * The gate, over an already-fetched project. Pure decision, no I/O, so the
 * country and edition rules are testable directly against the fixtures and
 * the store's own re-check inside the import transaction can stay a thin
 * last line of defence rather than a second copy of the rules.
 */
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

/**
 * Fetch, gate, import. The single entry point behind the member action.
 *
 * Order matters and is deliberate: the edition mapping is checked before any
 * network call (an unconfigured edition is HQ's own state, not Colosseum's,
 * and must not look like a Colosseum outage), then the project is fetched,
 * then country and edition are compared against the response body, then the
 * write happens.
 */
export async function importColosseumTeam(
  user: BuilderIdentity,
  input: { hackathonId: number; url: string },
  fetcher: ColosseumFetch = fetch,
): Promise<ImportOutcome> {
  const store = builderStore();
  const editionRow = await store.hackathon(input.hackathonId);
  const edition: EditionMapping = {
    hackathonId: editionRow.id, externalId: editionRow.externalId, externalSlug: editionRow.externalSlug,
    projectsOpen: editionRow.projectsOpen, projectsAvailableAt: editionRow.projectsAvailableAt,
  };
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

  try {
    // The `project.imported` audit event is written inside importTeam's own
    // transaction, so it cannot survive a rolled-back import or go missing
    // from a committed one.
    const projectId = await store.importTeam(user, {
      hackathonId: input.hackathonId,
      project,
      projectUrl: `https://colosseum.com/arena/projects/explore/${project.slug}`,
    });
    return { ok: true, projectId };
  } catch (error) {
    if (error instanceof ImportRefusedError) return refusal(error.reason);
    throw error;
  }
}

function refusal(reason: ImportRefusal): ImportOutcome {
  return { ok: false, reason, message: new ImportRefusedError(reason).message };
}

/**
 * A fresh snapshot for a team already in HQ: idempotent, and separate from
 * importing. A failed check records the failure and keeps the previous known
 * submission status rather than turning a green badge red.
 */
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
    if (error instanceof BuilderError) return { ok: false, reason: "unavailable", message: error.message };
    throw error;
  }
}
