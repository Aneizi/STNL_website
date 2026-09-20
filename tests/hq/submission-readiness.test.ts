// The final period's presentation rules, which are pure and therefore
// assertable without a database or a render: which materials this edition
// asks for, which a project actually has, and how the deadline reads.
//
// The plan's phase 10 acceptance behind each block:
//
// - "Distinguish Required, Optional and Unknown requirement information" and
//   "do not hardcode every available API link field as mandatory".
// - "Reuse imported presentation/pitch/demo/repository links and show missing
//   materials clearly. Do not mark an item complete merely because an
//   unrelated URL exists."
// - "Checklist readiness does not set Submitted."
import { describe,expect,it } from "vitest";

import {
isMaterialKey,
MATERIAL_KEYS,
MATERIAL_LABELS,
materialLinks,
materialRequirements,
REQUIREMENT_LABELS,submissionChecklist
} from "@/lib/hq/submission-readiness";

const EMPTY = {
  presentationLink: null, pitchVideoLink: null, technicalDemoLink: null,
  demoVideoLink: null, repoLink: null, website: null,
};

const requirements = (required: string[] = [], optional: string[] = []) =>
  materialRequirements({ requiredMaterials: required, optionalMaterials: optional });

describe("what this edition asks for", () => {
  it("treats a material nobody classified as Unknown, which is the default for every one of them", () => {
    const answer = requirements();
    expect(Object.values(answer).every((value) => value === "unknown")).toBe(true);
    expect(Object.keys(answer).sort()).toEqual([...MATERIAL_KEYS].sort());
  });

  it("reads the admin's own lists, and ignores a key that is not a material", () => {
    const answer = requirements(["presentation", "not-a-material"], ["demoVideo"]);
    expect(answer.presentation).toBe("required");
    expect(answer.demoVideo).toBe("optional");
    expect(answer.repo).toBe("unknown");
    expect(isMaterialKey("not-a-material")).toBe(false);
  });

  it("takes the stricter reading when a key was somehow put in both lists", () => {
    expect(requirements(["pitchVideo"], ["pitchVideo"]).pitchVideo).toBe("required");
  });

  it("has a distinct word for each of the three answers", () => {
    expect(new Set(Object.values(REQUIREMENT_LABELS)).size).toBe(3);
  });
});

describe("the checklist", () => {
  it("judges every material on its own field, never on another one's link", () => {
    const items = submissionChecklist({
      links: materialLinks({ ...EMPTY, repoLink: "https://example.test/code" }),
      requirements: requirements(["presentation", "repo"]),
    });
    const by = Object.fromEntries(items.map((item) => [item.key, item]));
    expect(by.repo).toMatchObject({ present: true, url: "https://example.test/code", requirement: "required" });
    // The one thing the plan names outright: an unrelated URL must not
    // complete a different material.
    expect(by.presentation).toMatchObject({ present: false, url: null, requirement: "required" });
    expect(by.pitchVideo.present).toBe(false);
  });

  it("names one link used for two materials as exactly that, on both rows, and never twice", () => {
    const shared = "https://example.test/deck";
    const items = submissionChecklist({
      links: materialLinks({ ...EMPTY, presentationLink: shared, pitchVideoLink: shared }),
      requirements: requirements(),
    });
    const by = Object.fromEntries(items.map((item) => [item.key, item]));
    expect(by.presentation.sharedWith).toEqual([MATERIAL_LABELS.pitchVideo]);
    expect(by.pitchVideo.sharedWith).toEqual([MATERIAL_LABELS.presentation]);
    expect(items.filter((item) => item.url === shared)).toHaveLength(2);
  });

  it("lists the materials in one fixed order whatever the project has", () => {
    const order = (links: Parameters<typeof materialLinks>[0]) =>
      submissionChecklist({ links: materialLinks(links), requirements: requirements() }).map((item) => item.key);
    expect(order(EMPTY)).toEqual([...MATERIAL_KEYS]);
    expect(order({ ...EMPTY, website: "https://example.test" })).toEqual([...MATERIAL_KEYS]);
  });
});
