// Phase 3's normalization and submission-status service, and the parts of
// the acceptance checklist that are answered by pure functions over the
// recorded fixtures: full, partial, null-image and duplicate-link responses,
// and the four distinct submission behaviours (confirmed submission,
// complete draft, unknown state, failed check).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fetchColosseumProject, type ColosseumFetch } from "@/lib/colosseum-api";
import {
  DRAFT_SIGNAL_CONFIRMED, groupedMaterials, interpretSubmission, PROJECT_FALLBACK_IMAGE,
  submittedOnTime, SUBMISSION_LABELS, toSnapshotFields,
} from "@/lib/hq/colosseum-snapshot";
import detail from "./fixtures/colosseum/detail.json";
import listing from "./fixtures/colosseum/listing.json";

const ROOT = process.cwd();
const url = (slug: string) => `https://colosseum.com/arena/projects/explore/${slug}`;
const respond = (body: unknown): ColosseumFetch => async () =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

describe("normalizing a Colosseum snapshot", () => {
  it("keeps every queryable field of the full fixture", async () => {
    const project = await fetchColosseumProject(url(detail.submitted.project.slug), respond(detail.submitted));
    expect(toSnapshotFields(project)).toMatchObject({
      name: "Tulip Ledger", slug: "tulip-ledger", country: "Netherlands",
      category: "Payments & Remittance", tracks: [], twitterHandle: "tulipledger",
      repoLink: "https://github.com/example-org/tulip-ledger",
      presentationLink: "https://www.example.com/tulip-ledger/deck",
      pitchVideoLink: "https://www.example.com/tulip-ledger/pitch",
      technicalDemoLink: null, demoVideoLink: null, website: null,
      imageUrl: "https://static.narrative-violation.com/fixtures/projects/tulip-ledger.png",
      submittedAt: "2026-05-11T20:00:00.000Z",
      completionIsComplete: true, completionMissingCount: 0,
      externalHackathonId: 6, externalHackathonSlug: "frontier", externalHackathonName: "Frontier",
    });
  });

  it("imports a partial project, with every optional field missing, rather than refusing it", async () => {
    const bare = {
      projectType: "HACKATHON",
      project: {
        id: 90007, hackathonId: 6, slug: "bare-project", name: "Bare Project", description: "",
        hackathon: detail.submitted.project.hackathon,
        teamMembers: [{ username: "fictional_builder_7", displayName: "Fictional Builder Seven", avatarUrl: null }],
      },
    };
    const project = await fetchColosseumProject(url("bare-project"), respond(bare));
    expect(toSnapshotFields(project)).toMatchObject({
      country: null, category: null, tracks: [], twitterHandle: null, imageUrl: null,
      submittedAt: null, completionIsComplete: null, completionMissingCount: null,
    });
  });

  it("treats an unusable image URL as no image, so the fallback takes over", async () => {
    const nullImage = { ...detail.submitted, project: { ...detail.submitted.project, image: null } };
    expect((await fetchColosseumProject(url("tulip-ledger"), respond(nullImage))).imageUrl).toBeNull();
    const unsafe = { ...detail.submitted, project: { ...detail.submitted.project, image: { url: "javascript:alert(1)" } } };
    expect((await fetchColosseumProject(url("tulip-ledger"), respond(unsafe))).imageUrl).toBeNull();
  });
});

describe("grouped submission materials", () => {
  it("shows a URL pasted into two fields once, naming both", () => {
    const shared = "https://www.example.com/one-link";
    expect(groupedMaterials({
      presentationLink: shared, technicalDemoLink: null, pitchVideoLink: shared, demoVideoLink: null,
    })).toEqual([{ label: "Presentation / Pitch video", url: shared }]);
  });

  it("keeps distinct URLs distinct, in a fixed order, and drops the empty ones", () => {
    expect(groupedMaterials({
      presentationLink: "https://www.example.com/deck", technicalDemoLink: null,
      pitchVideoLink: "https://www.example.com/pitch", demoVideoLink: null,
    })).toEqual([
      { label: "Presentation", url: "https://www.example.com/deck" },
      { label: "Pitch video", url: "https://www.example.com/pitch" },
    ]);
    expect(groupedMaterials({ presentationLink: null, technicalDemoLink: null, pitchVideoLink: null, demoVideoLink: null })).toEqual([]);
  });
});

describe("the submission signal", () => {
  it("is Not checked before any successful check, whatever the response said", () => {
    expect(interpretSubmission({ checked: false, submittedAt: "2026-05-11T20:00:00.000Z" })).toBe("not_checked");
    expect(interpretSubmission({ checked: false, submittedAt: null })).toBe("not_checked");
  });

  it("is Submitted on a confirmed submission timestamp", () => {
    expect(interpretSubmission({ checked: true, submittedAt: detail.submitted.project.submittedAt })).toBe("submitted");
  });

  it("stays Not checked for a complete draft while the draft signal is unconfirmed", () => {
    // The plan: `submittedAt` for a draft is an assumption, so HQ does not
    // show a red badge it cannot stand behind. This asserts the current,
    // deliberate state; flipping DRAFT_SIGNAL_CONFIRMED is what changes it,
    // and this test is the place that says so out loud.
    expect(DRAFT_SIGNAL_CONFIRMED).toBe(false);
    expect(interpretSubmission({ checked: true, submittedAt: detail.unsubmitted.project.submittedAt })).toBe("not_checked");
  });

  it("never reads readiness as submission", () => {
    // projectCompletion.isComplete is true on the submitted fixture and
    // false on the draft; neither is an input to interpretSubmission at all.
    expect(detail.submitted.projectCompletion.isComplete).toBe(true);
    expect(detail.unsubmitted.projectCompletion.isComplete).toBe(false);
    expect(interpretSubmission.length).toBe(1);
    expect(String(interpretSubmission)).not.toContain("isComplete");
  });

  it("labels the three states in words, not colour alone", () => {
    expect(SUBMISSION_LABELS).toEqual({ not_checked: "Not checked", submitted: "Submitted", not_submitted: "Not submitted" });
  });

  it("compares a submission against the edition deadline from the listing envelope", () => {
    const deadline = listing.hackathons[0].projectSubmissionEndDate;
    expect(submittedOnTime("2026-05-11T20:00:00.000Z", deadline)).toBe(true);
    expect(submittedOnTime("2026-05-13T00:00:00.000Z", deadline)).toBe(false);
    expect(submittedOnTime(null, deadline)).toBeNull();
    expect(submittedOnTime("2026-05-11T20:00:00.000Z", null)).toBeNull();
  });
});

describe("the approved fallback image", () => {
  it("is in place under public/, at the path the component references", () => {
    expect(PROJECT_FALLBACK_IMAGE).toBe("/images/hq/project-fallback.png");
    expect(existsSync(join(ROOT, "public", PROJECT_FALLBACK_IMAGE))).toBe(true);
  });

  it("is used for a missing image and for one that fails to load, and is never a human avatar", () => {
    const source = readFileSync(join(ROOT, "components/hq/builder-project-image.tsx"), "utf8");
    // Missing source, and an onError that swaps to the fallback.
    expect(source).toMatch(/!src \|\| failed \? PROJECT_FALLBACK_IMAGE : src/);
    expect(source).toMatch(/onError=\{\(\) => setFailed\(true\)\}/);
    // Contained proportions and one consistent size prop.
    expect(source).toContain('objectFit: "contain"');
    // No server-side image proxy: a plain tag, no next/image, no remote host
    // added to remotePatterns.
    expect(source).not.toMatch(/^\s*import .* from "next\/image"/m);
    expect(readFileSync(join(ROOT, "next.config.ts"), "utf8")).not.toContain("narrative-violation");
    // Nothing renders it for a person: the roster shows no avatar fallback.
    expect(readFileSync(join(ROOT, "components/hq/builder-onboarding.tsx"), "utf8"))
      .not.toMatch(/BuilderProjectImage[^>]*avatarUrl/);
  });
});
