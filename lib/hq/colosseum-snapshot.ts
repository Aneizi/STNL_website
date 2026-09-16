import type { ImportedProject } from "@/lib/colosseum-api";

/**
 * The Colosseum source snapshot as HQ stores and shows it: normalization,
 * submission-status interpretation and link grouping.
 *
 * Pure on purpose — no `server-only`, no database handle, no fetch — so the
 * store, the member pages, the admin pages and the tests all read the same
 * functions. The queries that persist these values live in
 * `lib/hq/builder-store.ts`; the HTTP that produces an `ImportedProject` lives
 * in `lib/colosseum-api.ts`.
 */

/** Where the approved globe medallion lives once phase 3 copies it in. Decorative project imagery, never a human avatar fallback. */
export const PROJECT_FALLBACK_IMAGE = "/images/hq/project-fallback.png";

/**
 * Colosseum submission as HQ shows it. Deliberately three states, not a
 * boolean: "Before the first successful status check, show neutral Not
 * checked", and a failed refresh keeps the previous known status rather than
 * turning green into red.
 */
export type SubmissionStatus = "not_checked" | "submitted" | "not_submitted";

export const SUBMISSION_LABELS: Record<SubmissionStatus, string> = {
  not_checked: "Not checked",
  submitted: "Submitted",
  not_submitted: "Not submitted",
};

/**
 * Whether a null `submittedAt` may be reported as "Not submitted".
 *
 * **CONFIRMED on 2026-09-14** by two live, unauthenticated reads of
 * `GET /api/project?slug=...&type=HACKATHON`, the same endpoint HQ imports
 * from:
 *
 * - a project of the in-flight Crypto World's Fair edition (external id 7,
 *   directory disabled, so it cannot have submitted) returned
 *   `"submittedAt": null` — the field **present and null**, not absent;
 * - a project of the finished Frontier edition (external id 6, submissions
 *   closed 2026-05-12) returned `"submittedAt": "2026-05-04T07:10:59.746Z"`.
 *
 * That is the submitted/unsubmitted pair this constant was waiting for: the
 * field is reliably populated for a submitted project and reliably null for
 * one that has not submitted, so a null may now drive a red "Not submitted".
 *
 * One caveat, stated rather than glossed: the two projects are from
 * **different editions**, because a same-edition pair is not obtainable — the
 * current edition's directory is disabled, so its submitted projects cannot
 * be listed or found by slug. Set this back to `false` if a project is ever
 * seen to have submitted while reporting a null `submittedAt`.
 *
 * `projectCompletion.isComplete` is not an input to any of this: a complete
 * draft is still a draft.
 */
export const DRAFT_SIGNAL_CONFIRMED = true;

/**
 * The ONE place a Colosseum response becomes a submission status.
 *
 * `projectCompletion.isComplete` is a readiness diagnostic and is deliberately
 * not an input here: a complete draft is still a draft.
 */
export function interpretSubmission(input: { checked: boolean; submittedAt: string | null }): SubmissionStatus {
  if (!input.checked) return "not_checked";
  if (input.submittedAt) return "submitted";
  return DRAFT_SIGNAL_CONFIRMED ? "not_submitted" : "not_checked";
}

/** Whether a submission timestamp beat the edition's deadline. Null when either side is unknown. */
export function submittedOnTime(submittedAt: string | null, submissionEnd: string | null, exclusiveEnd = false): boolean | null {
  if (!submittedAt || !submissionEnd) return null;
  const at = Date.parse(submittedAt);
  const end = Date.parse(submissionEnd);
  return Number.isFinite(at) && Number.isFinite(end) ? (exclusiveEnd ? at < end : at <= end) : null;
}

/** The normalized columns one Colosseum snapshot writes onto `hq_project_onboarding`. */
export type ProjectSnapshotFields = {
  name: string;
  slug: string;
  description: string;
  country: string | null;
  category: string | null;
  tracks: string[];
  twitterHandle: string | null;
  website: string | null;
  repoLink: string | null;
  presentationLink: string | null;
  technicalDemoLink: string | null;
  pitchVideoLink: string | null;
  demoVideoLink: string | null;
  imageUrl: string | null;
  submittedAt: string | null;
  completionIsComplete: boolean | null;
  completionMissingCount: number | null;
  externalHackathonId: number;
  externalHackathonSlug: string;
  externalHackathonName: string;
  raw: unknown;
};

/** An `ImportedProject` reduced to the queryable fields HQ stores beside the bounded raw snapshot. */
export function toSnapshotFields(project: ImportedProject): ProjectSnapshotFields {
  return {
    name: project.name,
    slug: project.slug,
    description: project.description,
    country: project.country,
    category: project.category,
    tracks: project.tracks,
    twitterHandle: project.twitterHandle,
    website: project.links.website,
    repoLink: project.links.repoLink,
    presentationLink: project.links.presentationLink,
    technicalDemoLink: project.links.technicalDemoLink,
    pitchVideoLink: project.links.pitchVideoLink,
    demoVideoLink: project.links.demoVideoLink,
    imageUrl: project.imageUrl,
    submittedAt: project.submittedAt,
    completionIsComplete: project.completion ? project.completion.isComplete : null,
    completionMissingCount: project.completion ? project.completion.missingFieldCount : null,
    externalHackathonId: project.hackathon.id,
    externalHackathonSlug: project.hackathon.slug,
    externalHackathonName: project.hackathon.name,
    raw: project.raw,
  };
}

export type MaterialLink = { label: string; url: string };

/**
 * Submission materials for display: the four link fields grouped, in a fixed
 * order, "with duplicate URLs shown once". A project that pasted one deck link
 * into two fields shows one row naming both, not two identical rows.
 */
export function groupedMaterials(links: {
  presentationLink: string | null;
  technicalDemoLink: string | null;
  pitchVideoLink: string | null;
  demoVideoLink: string | null;
}): MaterialLink[] {
  const ordered: Array<[string, string | null]> = [
    ["Presentation", links.presentationLink],
    ["Technical demo", links.technicalDemoLink],
    ["Pitch video", links.pitchVideoLink],
    ["Demo video", links.demoVideoLink],
  ];
  const byUrl = new Map<string, string[]>();
  for (const [label, url] of ordered) {
    if (!url) continue;
    const labels = byUrl.get(url);
    if (labels) labels.push(label);
    else byUrl.set(url, [label]);
  }
  return [...byUrl.entries()].map(([url, labels]) => ({ label: labels.join(" / "), url }));
}

/** Source freshness as a page shows it: when it was last read, and what went wrong if it failed. */
export type SourceStatus = {
  status: "never" | "ok" | "error";
  checkedAt: string | null;
  /** HQ's own error code (`ColosseumErrorCode`), never Colosseum's raw message. */
  errorCode: string | null;
};
