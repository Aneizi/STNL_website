import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertProjectHackathon,
  ColosseumApiError,
  fetchColosseumProject,
  fetchProjectComments,
  findProjectProof,
  parseColosseumProjectUrl,
  verifyProjectClaim,
  type ColosseumFetch,
} from "../lib/colosseum-api";

const projectUrl = "https://colosseum.com/arena/projects/explore/vaultmind-1";
const issuedAt = "2026-09-05T10:00:00.000Z";
const code = "3847291650";

function projectResponse(overrides: Record<string, unknown> = {}) {
  return {
    projectType: "HACKATHON",
    project: {
      id: 10103,
      hackathonId: 6,
      slug: "vaultmind-1",
      name: "VaultMind",
      description: "Security tooling.",
      country: "Netherlands",
      hackathon: { id: 6, slug: "frontier", name: "Frontier" },
      teamMembers: [
        { username: "nzarin", displayName: "Naqib", avatarUrl: null },
        { username: "TatMundo", displayName: "Tat", avatarUrl: "https://example.com/avatar.png" },
      ],
      website: "https://vaultmind.com",
      repoLink: "https://github.com/VaultMind/VaultTrace-v2",
      ...overrides,
    },
    projectCompletion: { isComplete: true, fieldErrors: [] },
  };
}

function comment(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    projectId: 10103,
    user: { id: 123, username: "nzarin", displayName: "Naqib" },
    body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: code }] }] },
    createdAt: "2026-09-05T10:01:00.000Z",
    isDeleted: false,
    replies: [],
    ...overrides,
  };
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
  return fetchColosseumProject(projectUrl, mockFetch([json(projectResponse())]));
}

afterEach(() => vi.useRealTimers());

describe("Colosseum project links", () => {
  it("extracts a slug and discards harmless share parameters", () => {
    expect(parseColosseumProjectUrl(`  ${projectUrl}/?utm_source=share#comments  `)).toBe("vaultmind-1");
  });

  it.each([
    "http://colosseum.com/arena/projects/explore/vaultmind-1",
    "https://colosseum.com.evil.test/arena/projects/explore/vaultmind-1",
    "https://colosseum.com@evil.test/arena/projects/explore/vaultmind-1",
    "https://evil@colosseum.com/arena/projects/explore/vaultmind-1",
    "https://colosseum.com:444/arena/projects/explore/vaultmind-1",
    "https://127.0.0.1/arena/projects/explore/vaultmind-1",
    "https://colosseum.com/arena/projects/explore/%2e%2e/secret",
    "https://colosseum.com/arena/projects/explore/foo/../vaultmind-1",
    "https://colosseum.com/arena/projects/explore/vaultmind-1%2fother",
    "https://colosseum.com/arena/projects/explore/vaultmind-1\\other",
    "https://colosseum.com/arena/projects/explore/with space",
    "https://colosseum.com/arena/projects/explore/vaultmind-1/extra",
    "https://colosseum.com/arena/projects/explore/",
    "vaultmind-1",
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
      externalId: 10103, slug: "vaultmind-1", country: "Netherlands",
      hackathon: { id: 6, slug: "frontier" },
      members: [{ username: "nzarin", displayName: "Naqib" }, { username: "TatMundo", displayName: "Tat" }],
      raw: input,
    });
    expect(String(fetcher.mock.calls[0][0])).toBe("https://api.colosseum.com/api/project?slug=vaultmind-1&type=HACKATHON");
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
    { id: "10103" },
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

  it.each([[404, "NOT_FOUND"], [429, "RATE_LIMITED"], [503, "UNAVAILABLE"]])("classifies HTTP %s safely", async (status, errorCode) => {
    await expect(fetchColosseumProject(projectUrl, mockFetch([json({ message: "sensitive upstream detail" }, Number(status))])))
      .rejects.toMatchObject({ code: errorCode, message: expect.not.stringContaining("sensitive") });
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
    const assertion = expect(fetchColosseumProject(projectUrl, fetcher)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await vi.advanceTimersByTimeAsync(6_000);
    await assertion;
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});

describe("comments and proof", () => {
  it("returns the current country, roster and details with the proof from that snapshot", async () => {
    const previous = await project();
    const current = projectResponse({
      country: "Belgium",
      name: "VaultMind updated",
      description: "Current imported description.",
      teamMembers: [{ username: "nzarin", displayName: "New display name", avatarUrl: null }],
    });
    const result = await verifyProjectClaim(previous, { code, issuedAt, claimedUsername: "nzarin" }, mockFetch([
      json(current), json({ comments: [comment()], offset: 0, hasMore: false }),
    ]));
    expect(result.proof).toEqual({ commentId: 100, authorId: 123, username: "nzarin" });
    expect(result.project).toMatchObject({
      country: "Belgium", name: "VaultMind updated", description: "Current imported description.",
      members: [{ username: "nzarin", displayName: "New display name", avatarUrl: null }], raw: current,
    });
    expect(result.project.members).toHaveLength(1);
    expect(previous.country).toBe("Netherlands");
    expect(previous.members).toHaveLength(2);
  });

  it("returns the fresh roster without proof after the claimed member is removed", async () => {
    const previous = await project();
    const result = await verifyProjectClaim(previous, { code, issuedAt, claimedUsername: "nzarin" }, mockFetch([
      json(projectResponse({ country: null, teamMembers: [{ username: "tatmundo", displayName: "Tat" }] })),
    ]));
    expect(result.proof).toBeNull();
    expect(result.project.country).toBeNull();
    expect(result.project.members.map(member => member.username)).toEqual(["tatmundo"]);
  });

  it("paginates by rows and extracts text across rich text marks", async () => {
    const fetcher = mockFetch([
      json({ comments: [comment({ body: { type: "doc", content: [{ type: "paragraph", content: [
        { type: "text", text: "38472", marks: [{ type: "bold" }] }, { type: "text", text: "91650" },
      ] }] } })], offset: 0, hasMore: true }),
      json({ comments: [comment({ id: 101 })], offset: 1, hasMore: false }),
    ]);
    const result = await fetchProjectComments(10103, fetcher);
    expect(result.map((item) => item.id)).toEqual([100, 101]);
    expect(result[0].text).toBe(code);
    expect(String(fetcher.mock.calls[1][0])).toBe("https://api.colosseum.com/api/project/comments?projectId=10103&offset=1");
  });

  it("accepts a recent exact code from a currently listed, claimed member", async () => {
    const item = await project();
    const fetcher = mockFetch([
      json(projectResponse()),
      json({ comments: [comment({
        user: { id: 321, username: "tatmundo" },
        body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `  ${code}  ` }] }] },
      })], offset: 0, hasMore: false }),
    ]);
    expect(await findProjectProof(item, { code, issuedAt, claimedUsername: "TatMundo" }, fetcher))
      .toEqual({ commentId: 100, authorId: 321, username: "tatmundo" });
  });

  it.each([
    { isDeleted: true },
    { createdAt: "2026-09-05T09:59:59.999Z" },
    { createdAt: "2099-01-01T00:00:00.000Z" },
    { user: { id: 444, username: "outsider" } },
    { body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `Verify ${code}` }] }] } },
    { body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "click", marks: [{ type: "link", attrs: { href: `https://example.com/${code}` } }] }] }] } },
    { body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "38472" }] }, { type: "paragraph", content: [{ type: "text", text: "91650" }] }] } },
  ])("does not accept invalid proof %j", async (overrides) => {
    const item = await project();
    const fetcher = mockFetch([
      json(projectResponse()), json({ comments: [comment(overrides)], offset: 0, hasMore: false }),
    ]);
    expect(await findProjectProof(item, { code, issuedAt }, fetcher)).toBeNull();
  });

  it("does not accept a different roster member as the claimed person", async () => {
    const item = await project();
    expect(await findProjectProof(item, { code, issuedAt, claimedUsername: "TatMundo" }, mockFetch([
      json(projectResponse()), json({ comments: [comment()], offset: 0, hasMore: false }),
    ]))).toBeNull();
  });

  it("rechecks the roster and refuses a member who has since been removed", async () => {
    const item = await project();
    const fetcher = mockFetch([
      json(projectResponse({ teamMembers: [{ username: "TatMundo", displayName: "Tat" }] })),
    ]);
    expect(await findProjectProof(item, { code, issuedAt, claimedUsername: "nzarin" }, fetcher)).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    { code: "metadata", issuedAt },
    { code, issuedAt: "not a timestamp" },
    { code, issuedAt: "2099-01-01T00:00:00Z" },
  ])("rejects malformed challenge %j without a network call", async (challenge) => {
    const item = await project();
    const fetcher = mockFetch([]);
    expect(await findProjectProof(item, challenge, fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { comments: [comment({ projectId: 8099 })], offset: 0, hasMore: false },
    { comments: [], offset: 0, hasMore: true },
    { comments: [comment()], offset: 10, hasMore: false },
  ])("rejects inconsistent comment responses %j", async (response) => {
    await expect(fetchProjectComments(10103, mockFetch([json(response)]))).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("bounds pagination and never reports an incomplete scan as verified", async () => {
    const fetcher = mockFetch(Array.from({ length: 5 }, (_, offset) => json({
      comments: [comment({ id: offset + 1 })], offset, hasMore: true,
    })));
    await expect(fetchProjectComments(10103, fetcher)).rejects.toMatchObject({ code: "TOO_MANY_COMMENTS" });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
});
