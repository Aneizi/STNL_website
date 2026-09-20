import { describe, expect, it, vi } from "vitest";
import { fetchColosseumUpdatePage, type ColosseumFetch } from "@/lib/colosseum-api";
import fixture from "./hq/fixtures/colosseum/updates.json";

const input = { projectUrl: "https://colosseum.com/arena/projects/tulip-ledger", externalId: 90001, externalHackathonId: 6 };
const transport = (body: unknown) => vi.fn<ColosseumFetch>().mockResolvedValue(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));

describe("Colosseum public update history", () => {
  it("preserves full written content, paragraph breaks, video links and original dates", async () => {
    const fetcher = transport(fixture);
    const page = await fetchColosseumUpdatePage(input, fetcher);
    expect(String(fetcher.mock.calls[0][0])).toBe("https://api.colosseum.com/api/projects/by-slug/tulip-ledger/build-logs?limit=20");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: "no-store", redirect: "error" });
    expect(page.updates[0]).toMatchObject({ body: "Our first working prototype.\nWatch the demo", links: ["https://static.narrative-violation.com/fixtures/demo.mp4"],
      publishedAt: new Date(fixture.buildLogs[0].publishedAt).toISOString(), sourceUrl: `${input.projectUrl}/updates/900101` });
  });
  it("follows opaque cursors without a date or import cutoff", async () => {
    const fetcher = transport({ ...fixture, nextCursor: "older/2+=" });
    const page = await fetchColosseumUpdatePage({ ...input, cursor: "older/1+=" }, fetcher);
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get("cursor")).toBe("older/1+=");
    expect(page.nextCursor).toBe("older/2+=");
  });
  it("keeps link-only video updates, deduplicates links and rejects executable URLs", async () => {
    const body = structuredClone(fixture);
    Object.assign(body.buildLogs[0], { content: null, excerpt: "", links: ["javascript:alert(1)", { url: "https://video.example.test/demo" }, "https://video.example.test/demo"] });
    const page = await fetchColosseumUpdatePage(input, transport(body));
    expect(page.updates[0]).toMatchObject({ body: "", links: ["https://video.example.test/demo"] });
  });
  it("does not truncate imported updates to HQ's writing limit", async () => {
    const body = structuredClone(fixture);
    body.buildLogs[0].content.content[0].content[0].text = "A".repeat(2_000);
    expect((await fetchColosseumUpdatePage(input, transport(body))).updates[0].body.length).toBeGreaterThan(2_000);
  });
  it.each([
    { ...fixture, project: { ...fixture.project, id: 99999 } },
    { ...fixture, project: { ...fixture.project, hackathonId: 99 } },
    { ...fixture, buildLogs: [{ ...fixture.buildLogs[0], projectId: 99999 }] },
    { ...fixture, buildLogs: [fixture.buildLogs[0], fixture.buildLogs[0]] },
    { ...fixture, nextCursor: "same" },
  ])("refuses mismatched projects, duplicate ids and repeated cursors", async body => {
    await expect(fetchColosseumUpdatePage({ ...input, cursor: "same" }, transport(body))).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
