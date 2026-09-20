import { describe, expect, it } from "vitest";
import { vi } from "vitest";

// github-actions-auth.ts is server-only; the guard package throws outside a
// React Server environment, so stub it for the test runner.
vi.mock("server-only", () => ({}));

import {
  HQ_JOBS_AUDIENCE,
  HQ_JOBS_JOB,
  LUMA_SYNC_AUDIENCE,
  LUMA_SYNC_JOB,
  isTrustedHqJobsRequest,
  isTrustedJobClaims,
  isTrustedLumaSyncRequest,
} from "@/lib/hq/github-actions-auth";

const claimsFor = (workflow: string) => ({
  repository: "Superteam-Netherlands/website",
  repository_id: "1313967087",
  repository_owner_id: "278071737",
  ref: "refs/heads/main",
  workflow_ref: `Superteam-Netherlands/website/.github/workflows/${workflow}@refs/heads/main`,
  runner_environment: "github-hosted",
  event_name: "schedule",
});

const validClaims = claimsFor("sync-luma.yml");

describe("scheduled Luma sync identity", () => {
  it("rejects requests without a bearer token before any key lookup", async () => {
    const request = new Request("https://nl.superteam.fun/api/cron/sync-luma");
    await expect(isTrustedLumaSyncRequest(request)).resolves.toBe(false);
  });

  it("accepts the exact scheduled workflow on main", () => {
    expect(isTrustedJobClaims(validClaims, LUMA_SYNC_JOB)).toBe(true);
  });

  it("accepts a manual dispatch of the same workflow", () => {
    expect(
      isTrustedJobClaims({ ...validClaims, event_name: "workflow_dispatch" }, LUMA_SYNC_JOB),
    ).toBe(true);
  });

  it.each([
    ["another repository", { repository: "attacker/website" }],
    ["a recycled repository name", { repository_id: "999" }],
    ["another owner", { repository_owner_id: "999" }],
    ["a non-main ref", { ref: "refs/heads/feature" }],
    [
      "another workflow",
      {
        workflow_ref:
          "Superteam-Netherlands/website/.github/workflows/ci.yml@refs/heads/main",
      },
    ],
    ["a self-hosted runner", { runner_environment: "self-hosted" }],
    ["a pull request", { event_name: "pull_request" }],
  ])("rejects %s", (_label, changes) => {
    expect(isTrustedJobClaims({ ...validClaims, ...changes }, LUMA_SYNC_JOB)).toBe(false);
  });
});

// Phase 8's requirement: "a new authenticated endpoint/audience limited to
// this work ... not shared privileges". Two jobs, two audiences, two workflow
// files, and neither one's identity opens the other's endpoint.
describe("the HQ reporting jobs identity is separate from the Luma sync's", () => {
  const hqClaims = claimsFor("hq-jobs.yml");

  it("gives each job its own audience", () => {
    expect(HQ_JOBS_AUDIENCE).toBe("stnl-hq-jobs");
    expect(LUMA_SYNC_AUDIENCE).toBe("stnl-luma-sync");
    expect(HQ_JOBS_AUDIENCE).not.toBe(LUMA_SYNC_AUDIENCE);
  });

  it("names the workflow file that is allowed to mint each one", () => {
    expect(HQ_JOBS_JOB).toEqual({ audience: "stnl-hq-jobs", workflow: "hq-jobs.yml" });
    expect(LUMA_SYNC_JOB).toEqual({ audience: "stnl-luma-sync", workflow: "sync-luma.yml" });
  });

  it("accepts the HQ jobs workflow on main, scheduled or dispatched by hand", () => {
    expect(isTrustedJobClaims(hqClaims, HQ_JOBS_JOB)).toBe(true);
    expect(isTrustedJobClaims({ ...hqClaims, event_name: "workflow_dispatch" }, HQ_JOBS_JOB)).toBe(true);
  });

  it("refuses the Luma sync's workflow at the HQ jobs endpoint, and the other way round", () => {
    // The audience alone would already separate them, because jwtVerify
    // checks it before the claims are read. The workflow check is the second
    // lock: a token with the right audience minted by the wrong file.
    expect(isTrustedJobClaims(validClaims, HQ_JOBS_JOB)).toBe(false);
    expect(isTrustedJobClaims(hqClaims, LUMA_SYNC_JOB)).toBe(false);
  });

  it("rejects an unauthenticated call to the HQ jobs endpoint before any key lookup", async () => {
    await expect(isTrustedHqJobsRequest(new Request("https://nl.superteam.fun/api/cron/hq-jobs"))).resolves.toBe(false);
  });

  it.each([
    ["another repository", { repository: "attacker/website" }],
    ["a recycled repository name", { repository_id: "999" }],
    ["another owner", { repository_owner_id: "999" }],
    ["a non-main ref", { ref: "refs/heads/feature" }],
    ["a self-hosted runner", { runner_environment: "self-hosted" }],
    ["a pull request", { event_name: "pull_request" }],
  ])("rejects %s for the HQ jobs endpoint too", (_label, changes) => {
    expect(isTrustedJobClaims({ ...hqClaims, ...changes }, HQ_JOBS_JOB)).toBe(false);
  });
});
