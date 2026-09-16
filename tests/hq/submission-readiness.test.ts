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
import { describe, expect, it } from "vitest";

import {
  checklistSummary,
  isMaterialKey,
  MATERIAL_KEYS,
  MATERIAL_LABELS,
  materialLinks,
  materialRequirements,
  REQUIREMENT_LABELS,
  SUBMISSION_COPY,
  SUBMISSION_STATE_COPY,
  sourceFreshnessLine,
  submissionChecklist,
  submissionDeadlineLabel,
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

describe("the summary a screen reads off the checklist", () => {
  const items = (links: Parameters<typeof materialLinks>[0], required: string[], optional: string[] = []) =>
    submissionChecklist({ links: materialLinks(links), requirements: requirements(required, optional) });

  it("counts only what this edition requires, and keeps the unknown ones apart", () => {
    const summary = checklistSummary(items(
      { ...EMPTY, presentationLink: "https://example.test/deck" },
      ["presentation", "pitchVideo"],
      ["website"],
    ));
    expect(summary).toMatchObject({
      requiredTotal: 2,
      requiredPresent: 1,
      missingRequired: [MATERIAL_LABELS.pitchVideo],
      missingOptional: [MATERIAL_LABELS.website],
      requiredComplete: false,
      requirementsUnknown: false,
    });
    expect(summary.unknownMissing).toContain(MATERIAL_LABELS.repo);
  });

  it("says every material is required and present only when every required one really is", () => {
    const complete = checklistSummary(items(
      { ...EMPTY, presentationLink: "https://example.test/deck", pitchVideoLink: "https://example.test/pitch" },
      ["presentation", "pitchVideo"],
    ));
    expect(complete.requiredComplete).toBe(true);
    // And a complete checklist is still not a submission: nothing in this
    // module says Submitted, which only `interpretSubmission` ever writes.
    expect(Object.keys(complete)).not.toContain("submitted");
  });

  it("does not call an edition with no requirements complete", () => {
    const none = checklistSummary(items({ ...EMPTY, repoLink: "https://example.test/code" }, []));
    expect(none).toMatchObject({ requiredTotal: 0, requiredComplete: false, requirementsUnknown: true });
  });
});

describe("the deadline a submission is judged against", () => {
  it("names the edition's official deadline in the campaign's own clock, not the server's", () => {
    // 2026-10-12T21:59Z is 23:59 in Amsterdam, which is what an admin typed.
    expect(submissionDeadlineLabel("2026-10-12T21:59:00.000Z", "Europe/Amsterdam", "2026-10-12"))
      .toBe("Monday 12 October at 23:59");
    expect(submissionDeadlineLabel("2026-10-12T21:59:00.000Z", "UTC", "2026-10-12"))
      .toBe("Monday 12 October at 21:59");
  });

  it("falls back to the period's own last day when the edition has recorded no deadline", () => {
    expect(submissionDeadlineLabel(null, "Europe/Amsterdam", "2026-10-12")).toBe("The end of Monday 12 October");
    expect(submissionDeadlineLabel("not a date", "Europe/Amsterdam", "2026-10-12")).toBe("The end of Monday 12 October");
  });
});

describe("how fresh the reading is", () => {
  it("says when the source was last read, and says so when the last attempt failed", () => {
    expect(sourceFreshnessLine({ sourceStatus: "never", sourceCheckedAt: null })).toBe(SUBMISSION_COPY.neverChecked);
    expect(sourceFreshnessLine({ sourceStatus: "ok", sourceCheckedAt: "2026-10-06T09:00:00.000Z" }))
      .toBe("Last read from Colosseum on 2026-10-06.");
    // A failed check keeps the previous known reading and says it is the
    // previous one, rather than turning a green badge red.
    expect(sourceFreshnessLine({ sourceStatus: "error", sourceCheckedAt: "2026-10-06T09:00:00.000Z" }))
      .toContain(SUBMISSION_COPY.staleAfterFailure);
  });
});

describe("the three submission states", () => {
  it("has a different, non-accusing sentence for each, including the one that claims nothing", () => {
    const lines = Object.values(SUBMISSION_STATE_COPY);
    expect(new Set(lines).size).toBe(3);
    expect(SUBMISSION_STATE_COPY.not_checked).toBe("We have not been able to read your submission status yet.");
  });

  it("says plainly that a full checklist is not a submission", () => {
    expect(SUBMISSION_COPY.readinessNotSubmission).toMatch(/not the same as submitting/);
  });
});
