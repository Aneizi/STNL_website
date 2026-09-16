// The final period's presentation rules and copy: which submission materials
// exist, whether this edition asks for each one, which of them a project has,
// and the words a screen says about all of it.
//
// No `server-only`, no database handle and no session, following
// `lib/hq/reporting-view.ts`: the member screens, the admin panel and the
// tests all read the same functions. `tests/hq/reporting-view.test.ts` scans
// the strings in this file for em dashes and middots along with the reporting
// copy, so interface wording that lives here is covered by the same rule.
//
// Two things this file is careful NOT to do, both of them the plan's own
// words:
//
// - It never decides that a project has SUBMITTED. That is
//   `interpretSubmission` in `lib/hq/colosseum-snapshot.ts`, over a signal
//   Colosseum gave, and a complete checklist here is readiness rather than
//   submission. "Checklist readiness does not set Submitted."
// - It never marks a material present because some other URL exists. Each
//   item is present when ITS OWN named field carries a link, so a team that
//   pasted a repository link cannot be told its pitch video is done. A single
//   link used for two materials is shown as exactly that, once per item, with
//   the other items it is shared with named.

import type { SubmissionStatus } from "./colosseum-snapshot";

/** How firmly this edition asks for a material. Unknown is a real answer, not a missing one. */
export type MaterialRequirement = "required" | "optional" | "unknown";

export const REQUIREMENT_LABELS: Record<MaterialRequirement, string> = {
  required: "Required",
  optional: "Optional",
  unknown: "Not known",
};

/**
 * The material keys, in the order a screen lists them. These are the link
 * fields a Colosseum project actually carries
 * (`lib/colosseum-schema.ts#projectBodySchema`), which is why there are six
 * and no more: HQ shows what the source has, and asks an admin which of them
 * this edition requires rather than deciding for them.
 */
export const MATERIAL_KEYS = [
  "presentation",
  "pitchVideo",
  "technicalDemo",
  "demoVideo",
  "repo",
  "website",
] as const;

export type MaterialKey = (typeof MATERIAL_KEYS)[number];

export const MATERIAL_LABELS: Record<MaterialKey, string> = {
  presentation: "Presentation or pitch deck",
  pitchVideo: "Pitch video",
  technicalDemo: "Technical demo",
  demoVideo: "Demo video",
  repo: "Code repository",
  website: "Project website",
};

/** Whether a string is one of the material keys, for reading a stored configuration array back. */
export const isMaterialKey = (value: unknown): value is MaterialKey =>
  typeof value === "string" && (MATERIAL_KEYS as readonly string[]).includes(value);

/** The six link fields as the stored snapshot carries them, keyed the way this module names them. */
export type SubmissionMaterialLinks = Record<MaterialKey, string | null>;

/** The snapshot's own column names mapped onto the material keys, so the mapping is written once. */
export function materialLinks(source: {
  presentationLink: string | null;
  pitchVideoLink: string | null;
  technicalDemoLink: string | null;
  demoVideoLink: string | null;
  repoLink: string | null;
  website: string | null;
}): SubmissionMaterialLinks {
  return {
    presentation: source.presentationLink,
    pitchVideo: source.pitchVideoLink,
    technicalDemo: source.technicalDemoLink,
    demoVideo: source.demoVideoLink,
    repo: source.repoLink,
    website: source.website,
  };
}

/**
 * The edition's requirement for every material.
 *
 * `required` wins over `optional` when an admin has somehow listed a key in
 * both, because the stricter reading is the safe one to show a team the week
 * before a deadline. A key in neither list is `unknown`, and a key in neither
 * list is the DEFAULT: nothing is required until somebody says so.
 */
export function materialRequirements(config: {
  requiredMaterials: readonly string[];
  optionalMaterials: readonly string[];
}): Record<MaterialKey, MaterialRequirement> {
  const required = new Set(config.requiredMaterials.filter(isMaterialKey));
  const optional = new Set(config.optionalMaterials.filter(isMaterialKey));
  return Object.fromEntries(
    MATERIAL_KEYS.map((key) => [key, required.has(key) ? "required" : optional.has(key) ? "optional" : "unknown"]),
  ) as Record<MaterialKey, MaterialRequirement>;
}

export type ChecklistItem = {
  key: MaterialKey;
  label: string;
  requirement: MaterialRequirement;
  /** This material's own link, or null. Never another material's. */
  url: string | null;
  present: boolean;
  /** The other materials pointing at the same URL, so one deck in two fields reads as one deck. */
  sharedWith: string[];
};

/**
 * The checklist for one project: one row per material, in a fixed order,
 * judged only on its own field.
 */
export function submissionChecklist(input: {
  links: SubmissionMaterialLinks;
  requirements: Record<MaterialKey, MaterialRequirement>;
}): ChecklistItem[] {
  const byUrl = new Map<string, MaterialKey[]>();
  for (const key of MATERIAL_KEYS) {
    const url = input.links[key];
    if (!url) continue;
    const keys = byUrl.get(url);
    if (keys) keys.push(key);
    else byUrl.set(url, [key]);
  }
  return MATERIAL_KEYS.map((key) => {
    const url = input.links[key];
    const shared = url ? (byUrl.get(url) ?? []).filter((other) => other !== key) : [];
    return {
      key,
      label: MATERIAL_LABELS[key],
      requirement: input.requirements[key],
      url: url ?? null,
      present: Boolean(url),
      sharedWith: shared.map((other) => MATERIAL_LABELS[other]),
    };
  });
}

export type ChecklistSummary = {
  requiredTotal: number;
  requiredPresent: number;
  missingRequired: string[];
  missingOptional: string[];
  /** Materials this edition has not classified. Their absence proves nothing, so they are counted separately. */
  unknownMissing: string[];
  /** Every material this edition requires is there. Readiness, never submission. */
  requiredComplete: boolean;
  /** No requirement information has been recorded for this edition at all. */
  requirementsUnknown: boolean;
};

export function checklistSummary(items: readonly ChecklistItem[]): ChecklistSummary {
  const required = items.filter((item) => item.requirement === "required");
  const missing = (requirement: MaterialRequirement) =>
    items.filter((item) => item.requirement === requirement && !item.present).map((item) => item.label);
  return {
    requiredTotal: required.length,
    requiredPresent: required.filter((item) => item.present).length,
    missingRequired: missing("required"),
    missingOptional: missing("optional"),
    unknownMissing: missing("unknown"),
    requiredComplete: required.length > 0 && required.every((item) => item.present),
    requirementsUnknown: items.every((item) => item.requirement === "unknown"),
  };
}

/**
 * The deadline a submission is judged against, said in the campaign's own
 * clock: the edition's recorded official deadline when there is one, else the
 * final period's own last day.
 */
export function submissionDeadlineLabel(
  officialDeadline: string | null,
  timezone: string,
  periodEndDate: string,
): string {
  if (!officialDeadline) return `The end of ${dayLabel(periodEndDate)}`;
  const at = new Date(officialDeadline);
  if (!Number.isFinite(at.getTime())) return `The end of ${dayLabel(periodEndDate)}`;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(at);
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "Monday 12 October", from an inclusive local date. Same shape as the weekly deadline line. */
function dayLabel(isoDate: string): string {
  if (!isoDate) return "";
  const at = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(at)) return "";
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const [, month, day] = isoDate.split("-").map(Number);
  return `${days[(new Date(at).getUTCDay() + 6) % 7]} ${day} ${MONTHS[month - 1] ?? ""}`;
}

/**
 * What HQ says about a project's submission, in one sentence per state.
 *
 * "Not checked" is neutral and says so. A stale reading after a failed check
 * keeps whatever was known and says the last check did not get through,
 * rather than turning an established Submitted into anything else.
 */
export const SUBMISSION_STATE_COPY: Record<SubmissionStatus, string> = {
  submitted: "Colosseum has your submission.",
  not_submitted: "Colosseum does not have your submission yet.",
  not_checked: "We have not been able to read your submission status yet.",
};

export const SUBMISSION_COPY = {
  heading: "Your submission",
  intro: "This is the last stretch. What matters now is your Colosseum submission, not another written update.",
  materialsHeading: "Submission materials",
  unknownRequirements:
    "Superteam NL has not recorded which materials this hackathon asks for, so nothing below is marked required. Check the hackathon's own rules on Colosseum.",
  readinessNotSubmission: "Having every material ready is not the same as submitting. Submit on Colosseum when you are done.",
  openSubmission: "Open your project on Colosseum",
  recheck: "Check submission",
  rechecking: "Checking",
  rechecked: "Checked with Colosseum.",
  staleAfterFailure: "The last check did not get through, so this is the last thing we knew.",
  neverChecked: "Not read from Colosseum yet.",
  sharedLinkPrefix: "Same link as",
  updateStillOpen: "You can still add an update, and one is not required if your submission is confirmed in time.",
  completedBySubmission: "Your confirmed submission completes this period.",
  lateSubmission: "This submission came in after the deadline, so the period stays recorded as not updated.",
  reconciliationPending:
    "We could not reach Colosseum to confirm this at the close of the period. Nothing has been recorded against the team; we will confirm it as soon as we can.",
} as const;

/**
 * How a source read is described: when it last succeeded and whether the last
 * attempt failed. Deliberately two facts, because a failed check leaves the
 * previous known status standing and a screen must not present stale
 * information as fresh.
 */
export function sourceFreshnessLine(source: {
  sourceStatus: "never" | "ok" | "error";
  sourceCheckedAt: string | null;
}): string {
  const last = source.sourceCheckedAt ? `Last read from Colosseum on ${source.sourceCheckedAt.slice(0, 10)}.` : SUBMISSION_COPY.neverChecked;
  return source.sourceStatus === "error" ? `${last} ${SUBMISSION_COPY.staleAfterFailure}` : last;
}
