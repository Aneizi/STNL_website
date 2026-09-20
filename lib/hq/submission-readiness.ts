// Checklist presence comes from each material's own link. Readiness never
// establishes an official submission; only the Colosseum snapshot can do that.

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
