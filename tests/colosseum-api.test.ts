import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertProjectHackathon,
  ColosseumApiError,
  fetchColosseumProject,
  fetchEditionSubmissionWindow,
  parseColosseumProjectUrl,
  type ColosseumFetch,
} from "../lib/colosseum-api";
import detail from "./hq/fixtures/colosseum/detail.json";
import errors from "./hq/fixtures/colosseum/errors.json";
import listing from "./hq/fixtures/colosseum/listing.json";

// Structural fixture with invented people and projects. See
// tests/hq/fixtures/colosseum/README.md.
const submitted = detail.submitted;
const projectSlug = submitted.project.slug;
const projectUrl = `https://colosseum.com/arena/projects/explore/${projectSlug}`;

function projectResponse(overrides: Record<string, unknown> = {}) {
  return { ...submitted, project: { ...submitted.project, ...overrides } };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function mockFetch(responses: Response[]) {
  return vi.fn<ColosseumFetch>().mockImplementation(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected fetch");
    return response;
  });
}

async function project() {
  return fetchColosseumProject(projectUrl, mockFetch([json(detail.submitted)]));
}

afterEach(() => vi.useRealTimers());

describe("Colosseum project links", () => {
  it("extracts a slug and discards harmless share parameters", () => {
    expect(parseColosseumProjectUrl(`  ${projectUrl}/?utm_source=share#comments  `)).toBe(projectSlug);
  });

  it.each([
    `http://colosseum.com/arena/projects/explore/${projectSlug}`,
    `https://colosseum.com.evil.test/arena/projects/explore/${projectSlug}`,
    `https://colosseum.com@evil.test/arena/projects/explore/${projectSlug}`,
    `https://evil@colosseum.com/arena/projects/explore/${projectSlug}`,
    `https://colosseum.com:444/arena/projects/explore/${projectSlug}`,
    `https://127.0.0.1/arena/projects/explore/${projectSlug}`,
    "https://colosseum.com/arena/projects/explore/%2e%2e/secret",
    `https://colosseum.com/arena/projects/explore/foo/../${projectSlug}`,
    `https://colosseum.com/arena/projects/explore/${projectSlug}%2fother`,
    `https://colosseum.com/arena/projects/explore/${projectSlug}\\other`,
    "https://colosseum.com/arena/projects/explore/with space",
    `https://colosseum.com/arena/projects/explore/${projectSlug}/extra`,
    "https://colosseum.com/arena/projects/explore/",
    projectSlug,
  ])("rejects unsafe or unsupported link %s before fetching", async (url) => {
    const fetcher = mockFetch([]);
    await expect(fetchColosseumProject(url, fetcher)).rejects.toMatchObject({ code: "INVALID_URL" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("project adapter", () => {
  it("retains project country and raw import data and derives the actual project ID", async () => {
    const input = projectResponse({ extraProviderField: "retained" });
    const fetcher = mockFetch([json(input)]);
    const result = await fetchColosseumProject(projectUrl, fetcher);
    expect(result).toMatchObject({
      externalId: 90001, slug: "tulip-ledger", country: "Netherlands",
      hackathon: { id: 6, slug: "frontier" },
      members: [
        { username: "fictional_builder_1", displayName: "Fictional Builder One" },
        { username: "Fictional_Builder_2", displayName: "Fictional Builder Two" },
      ],
      raw: input,
    });
    expect(String(fetcher.mock.calls[0][0])).toBe("https://api.colosseum.com/api/project?slug=tulip-ledger&type=HACKATHON");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: "no-store", redirect: "error", method: "GET" });
    expect(fetcher.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([null, "Belgium", "Netherlands"])("preserves country %s for the caller's eligibility decision", async (country) => {
    const result = await fetchColosseumProject(projectUrl, mockFetch([json(projectResponse({ country }))]));
    expect(result.country).toBe(country);
  });

  it("discards unsafe display links without discarding raw data", async () => {
    const result = await fetchColosseumProject(projectUrl, mockFetch([json(projectResponse({
      website: "javascript:alert(1)", repoLink: "https://name:password@example.com/repo",
      image: { url: "data:image/svg+xml,not-safe" },
    }))]));
    expect(result.links.website).toBeNull();
    expect(result.links.repoLink).toBeNull();
    expect(result.imageUrl).toBeNull();
  });

  it.each([
    { slug: "different-slug" },
    { id: "90001" },
    { hackathonId: 7 },
    { teamMembers: [] },
    { teamMembers: [{ username: "alice", displayName: "Alice" }, { username: "ALICE", displayName: "Different" }] },
  ])("rejects inconsistent identity/schema %j", async (overrides) => {
    await expect(fetchColosseumProject(projectUrl, mockFetch([json(projectResponse(overrides))])))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("requires the correct hackathon ID and slug", async () => {
    const item = await project();
    expect(() => assertProjectHackathon(item, { externalId: 6, slug: "frontier" })).not.toThrow();
    expect(() => assertProjectHackathon(item, { externalId: 6, slug: "worldsfair" })).toThrow(ColosseumApiError);
    expect(() => assertProjectHackathon(item, { externalId: 7, slug: "frontier" })).toThrow(ColosseumApiError);
  });

  // Phase 3: every one of these is its own outcome. A 4xx that is not a 404
  // no longer collapses into UNAVAILABLE, which is what lets a caller tell
  // "directory disabled" from "unknown edition".
  it.each([[404, "NOT_FOUND"], [429, "RATE_LIMITED"], [400, "SOURCE_REJECTED"], [403, "SOURCE_REJECTED"], [503, "UNAVAILABLE"]])(
    "classifies HTTP %s as its own code, without putting upstream text in the message",
    async (status, errorCode) => {
      await expect(fetchColosseumProject(projectUrl, mockFetch([json({ message: "sensitive upstream detail" }, Number(status))])))
        .rejects.toMatchObject({ code: errorCode, message: expect.not.stringContaining("sensitive") });
    },
  );

  it("carries Colosseum's own code and message as data, never as the shown message", async () => {
    const disabled = errors.listingDirectoryDisabled;
    const unknown = errors.listingUnknownHackathon;
    await expect(fetchColosseumProject(projectUrl, mockFetch([json(disabled.body, disabled.status)])))
      .rejects.toMatchObject({ code: "SOURCE_REJECTED", sourceCode: "BAD_REQUEST", sourceMessage: disabled.body.message });
    // The same two failures the old adapter could not tell apart.
    await expect(fetchColosseumProject(projectUrl, mockFetch([json(unknown.body, unknown.status)])))
      .rejects.toMatchObject({ code: "NOT_FOUND", sourceCode: "NOT_FOUND", sourceMessage: unknown.body.message });
  });

  it("rejects non-JSON, oversized, deeply nested, and malformed responses", async () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 45; i++) { cursor.next = {}; cursor = cursor.next as Record<string, unknown>; }
    for (const response of [
      new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } }),
      json({ excessive: "x".repeat(1_000_001) }),
      json(deep),
      new Response("{broken", { headers: { "Content-Type": "application/json" } }),
    ]) {
      await expect(fetchColosseumProject(projectUrl, mockFetch([response]))).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }
  });

  it("aborts a stalled upstream request", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<ColosseumFetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("private network address")), { once: true });
    }));
    // A timeout is its own outcome, separate from an unreachable host and
    // from a 404: it invites a retry rather than implying the project is gone.
    const assertion = expect(fetchColosseumProject(projectUrl, fetcher)).rejects.toMatchObject({ code: "TIMED_OUT" });
    await vi.advanceTimersByTimeAsync(6_000);
    await assertion;
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("reports an unreachable host separately from a timeout", async () => {
    const fetcher = vi.fn<ColosseumFetch>().mockRejectedValue(new TypeError("fetch failed"));
    await expect(fetchColosseumProject(projectUrl, fetcher)).rejects.toMatchObject({ code: "UNREACHABLE" });
  });

  it("normalises the phase 3 snapshot fields from the detail response", async () => {
    const result = await fetchColosseumProject(projectUrl, mockFetch([json(detail.submitted)]));
    expect(result).toMatchObject({
      category: "Payments & Remittance",
      tracks: [],
      twitterHandle: "tulipledger",
      submittedAt: "2026-05-11T20:00:00.000Z",
      completion: { isComplete: true, missingFieldCount: 0 },
      imageUrl: "https://static.narrative-violation.com/fixtures/projects/tulip-ledger.png",
    });
    expect(result.links.presentationLink).toBe("https://www.example.com/tulip-ledger/deck");
    expect(result.members[1].avatarUrl).toBe("https://static.narrative-violation.com/fixtures/avatars/fictional-builder-two.png");
  });

  it("reads the unsubmitted fixture without losing its null submittedAt", async () => {
    const url = `https://colosseum.com/arena/projects/explore/${detail.unsubmitted.project.slug}`;
    const result = await fetchColosseumProject(url, mockFetch([json(detail.unsubmitted)]));
    expect(result.submittedAt).toBeNull();
    expect(result.completion).toEqual({ isComplete: false, missingFieldCount: 2 });
  });

  it("imports a project whose optional fields are all missing", async () => {
    const bare = projectResponse({
      category: null, tracks: null, twitterHandle: null, submittedAt: null, image: null,
      website: null, repoLink: null, presentationLink: null, technicalDemoLink: null,
      pitchVideoLink: null, demoVideoLink: null, country: null,
    });
    const result = await fetchColosseumProject(projectUrl, mockFetch([json({ ...bare, projectCompletion: undefined })]));
    expect(result).toMatchObject({ category: null, tracks: [], twitterHandle: null, submittedAt: null, imageUrl: null, completion: null });
  });
});

describe("the edition submission window", () => {
  it("reads projectSubmissionEndDate from the listing envelope with bracket array encoding", async () => {
    const fetcher = mockFetch([json(listing)]);
    const window = await fetchEditionSubmissionWindow(6, fetcher);
    expect(window).toEqual({
      // The listing envelope's hackathons block carries no slug; only the
      // project's own `hackathon` object does. Null, never guessed.
      externalId: 6, name: "Frontier", slug: null,
      submissionStart: "2026-05-04T11:00:00.000Z",
      submissionEnd: "2026-05-12T06:59:00.000Z",
      directoryEnabled: true,
    });
    // `sort` is REQUIRED: without it the live API answers 400 "Invalid
    // discriminator value. Expected 'RANDOM' | 'NAME'" (observed 2026-09-14),
    // so this assertion is what stops the parameter being dropped again.
    expect(String(fetcher.mock.calls[0][0])).toBe("https://api.colosseum.com/api/projects?hackathonIds%5B%5D=6&sort=NAME");
  });

  it("returns null when the envelope does not carry the edition asked for", async () => {
    expect(await fetchEditionSubmissionWindow(7, mockFetch([json(listing)]))).toBeNull();
  });

  it("still reads the window when a listed project is one this client would refuse", async () => {
    // Observed live on 2026-09-14: a real Frontier project carries the slug
    // `""or""or`. The window read does not look at a single listing row, so
    // one pathological project must not take the whole edition's deadline
    // down with it.
    const hostile = { ...listing, projects: [{ ...listing.projects[0], slug: '""or""or' }, { nonsense: true }] };
    expect(await fetchEditionSubmissionWindow(6, mockFetch([json(hostile)])))
      .toMatchObject({ externalId: 6, submissionEnd: "2026-05-12T06:59:00.000Z" });
  });

  it("keeps a disabled directory distinguishable from an unknown edition", async () => {
    const disabled = errors.listingDirectoryDisabledOnly;
    await expect(fetchEditionSubmissionWindow(7, mockFetch([json(disabled.body, disabled.status)])))
      .rejects.toMatchObject({ code: "SOURCE_REJECTED", sourceMessage: disabled.body.message });
    const unknown = errors.listingUnknownHackathon;
    await expect(fetchEditionSubmissionWindow(99, mockFetch([json(unknown.body, unknown.status)])))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
