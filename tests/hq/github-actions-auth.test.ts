import { describe, expect, it, vi } from "vitest";

// github-actions-auth.ts is server-only; the guard package throws outside a
// React Server environment, so stub it for the test runner.
vi.mock("server-only", () => ({}));

import {
  isTrustedLumaSyncClaims,
  isTrustedLumaSyncRequest,
} from "@/lib/hq/github-actions-auth";

const validClaims = {
  repository: "Superteam-Netherlands/website",
  repository_id: "1313967087",
  repository_owner_id: "278071737",
  ref: "refs/heads/main",
  workflow_ref:
    "Superteam-Netherlands/website/.github/workflows/sync-luma.yml@refs/heads/main",
  runner_environment: "github-hosted",
  event_name: "schedule",
};

describe("scheduled Luma sync identity", () => {
  it("rejects requests without a bearer token before any key lookup", async () => {
    const request = new Request("https://nl.superteam.fun/api/cron/sync-luma");
    await expect(isTrustedLumaSyncRequest(request)).resolves.toBe(false);
  });

  it("accepts the exact scheduled workflow on main", () => {
    expect(isTrustedLumaSyncClaims(validClaims)).toBe(true);
  });

  it("accepts a manual dispatch of the same workflow", () => {
    expect(
      isTrustedLumaSyncClaims({ ...validClaims, event_name: "workflow_dispatch" }),
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
    expect(isTrustedLumaSyncClaims({ ...validClaims, ...changes })).toBe(false);
  });
});
