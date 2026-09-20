import type { ImportedProject } from "@/lib/colosseum-api";

/** Pure snapshot normalization and submission interpretation shared by every surface. */

/** Decorative project fallback, never a human avatar. */
export const PROJECT_FALLBACK_IMAGE = "/images/hq/project-fallback.png";

/** Failed checks retain the last known status; an unchecked source is neutral. */
export type SubmissionStatus = "not_checked" | "submitted" | "not_submitted";

export const SUBMISSION_LABELS: Record<SubmissionStatus, string> = {
  not_checked: "Not checked",
  submitted: "Submitted",
  not_submitted: "Not submitted",
};

/**
 * A present, null submittedAt means a draft. Confirmed from public detail
 * responses in different editions; revert if a submitted project contradicts it.
 * Readiness is never submission evidence.
 */
export const DRAFT_SIGNAL_CONFIRMED = true;

/** The single interpretation of source submission evidence. */
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
export type ProjectSourceFields = Pick<ImportedProject,
  "category" | "tracks" | "twitterHandle" | "imageUrl" | "submittedAt"
> & ImportedProject["links"];

type ProjectSnapshotFields = ProjectSourceFields & Pick<ImportedProject,
  "name" | "slug" | "description" | "country"
> & {
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
