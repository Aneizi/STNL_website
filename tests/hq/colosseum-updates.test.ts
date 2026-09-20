import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColosseumFetch } from "@/lib/colosseum-api";
import type { Actor } from "@/lib/hq/actor";
import type { BuilderDatabase } from "@/lib/hq/builder-db";
import { readColosseumHistory, syncColosseumUpdates, syncDueColosseumUpdates } from "@/lib/hq/colosseum-updates";
import { runDueWork } from "@/lib/hq/jobs";
import { createMigratedDatabase, pgliteBuilderDatabase, applySqlFile } from "./helpers/db";
import fixture from "./fixtures/colosseum/updates.json";

vi.mock("server-only", () => ({}));
const PROJECT = "00000000-0000-4000-9000-000000000001";
const NOW = Date.parse("2026-09-25T12:00:00Z");
const operator: Actor = { kind: "operator", id: "00000000-0000-4000-9000-000000000002", displayName: "Admin" };
const member = (id: string): Actor => ({ kind: "member", id, name: id, email: `${id}@example.test`, telegram: null, capabilities: new Set() });
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const transport = () => vi.fn<ColosseumFetch>().mockImplementation(async () => response(fixture));
let pg: PGlite;
let db: BuilderDatabase;
const rows = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows;

beforeAll(async () => {
  pg = await createMigratedDatabase(); db = pgliteBuilderDatabase(pg);
  await rows("INSERT INTO hq_hackathons(id,slug,name,start_date,end_date) VALUES(91,'test-history','History','2026-09-14','2026-10-12')");
  await rows("INSERT INTO hq_project_statuses(slug,label,color) VALUES('test-history','Test','muted') ON CONFLICT DO NOTHING");
  await rows("INSERT INTO hq_project_forecasts(slug,label,color) VALUES('test-history','Test','muted') ON CONFLICT DO NOTHING");
  await rows(`INSERT INTO hq_auth_user(id,name,email,"emailVerified") VALUES('history-owner','Owner','owner@example.test',true)`);
  await rows("INSERT INTO hq_builder_profiles(id,name,email) VALUES('history-owner','Owner','owner@example.test')");
});
afterAll(async () => { await pg.close(); });
beforeEach(async () => {
  await rows("DELETE FROM hq_projects WHERE hackathon_id=91");
  await rows("UPDATE hq_hackathons SET archived_at=NULL WHERE id=91");
  await rows(`INSERT INTO hq_projects(id,hackathon_id,name,status_id,forecast_id,last_check_in)
    SELECT $1,91,'Tulip Ledger',s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f LIMIT 1`, [PROJECT]);
  await rows(`INSERT INTO hq_project_onboarding(project_id,hackathon_id,external_id,external_hackathon_id,project_url,slug,raw,owner_user_id,verification,lead_username,created_at)
    VALUES($1,91,90001,6,'https://colosseum.com/arena/projects/tulip-ledger','tulip-ledger','{}','history-owner','verified','fictional_builder_1','2026-09-22')`, [PROJECT]);
});

describe("Colosseum history sync", () => {
  it("runs from the normal background job without a submission period or reporting enrollment", async () => {
    const fetcher = transport();
    const summary = await runDueWork({ db, now: NOW, sender: null, colosseumFetch: fetcher, hackathonId: 91 });
    expect(summary.colosseumUpdates).toMatchObject({ synced: 1, failed: 0 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("discovers existing imports without reporting enrollment and backfills posts older than initialization", async () => {
    const fetcher = transport();
    expect(await syncDueColosseumUpdates(db, { now: NOW, fetcher })).toMatchObject({ synced: 1, failed: 0 });
    expect(await rows("SELECT count(*)::int AS n FROM hq_colosseum_updates")).toEqual([{ n: 1 }]);
    const page = await readColosseumHistory(operator, { projectId: PROJECT, hackathonId: 91 }, db, { now: NOW, fetcher });
    expect(page.updates[0].publishedAt).toBe(new Date(fixture.buildLogs[0].publishedAt).toISOString());
    expect(page.updates[0].links).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await rows("SELECT count(*)::int AS n FROM hq_reporting_entries")).toEqual([{ n: 0 }]);
  });
  it("supports legacy imports with no normalized external edition while still matching the original project id", async () => {
    await rows("UPDATE hq_project_onboarding SET external_hackathon_id=NULL WHERE project_id=$1", [PROJECT]);
    expect(await syncColosseumUpdates(db, PROJECT, { now: NOW, fetcher: transport() })).toBe("synced");
  });
  it("restarts an expired upstream cursor without losing imported history", async () => {
    const fetcher = vi.fn<ColosseumFetch>()
      .mockResolvedValueOnce(response({ ...fixture, nextCursor: "expired" }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "BAD_REQUEST" }), { status: 400, headers: { "Content-Type": "application/json" } }))
      .mockImplementation(async () => response(fixture));
    await syncColosseumUpdates(db, PROJECT, { now: NOW, fetcher });
    await syncColosseumUpdates(db, PROJECT, { now: NOW, fetcher });
    expect(await rows("SELECT cursor FROM hq_colosseum_update_sync")).toEqual([{ cursor: null }]);
    await syncColosseumUpdates(db, PROJECT, { now: NOW + 15 * 60_000, fetcher });
    expect(new URL(String(fetcher.mock.calls[2][0])).searchParams.has("cursor")).toBe(false);
    expect(await rows("SELECT count(*)::int AS n FROM hq_colosseum_updates")).toEqual([{ n: 1 }]);
  });
  it("resumes older pages, then starts a new sweep to pick up new posts and edited old posts", async () => {
    const fetcher = vi.fn<ColosseumFetch>()
      .mockResolvedValueOnce(response({ ...fixture, nextCursor: "older" }))
      .mockResolvedValueOnce(response({ ...fixture, buildLogs: [{ ...fixture.buildLogs[0], id: 900100, publishedAt: fixture.buildLogs[0].publishedAt - 86_400_000 }] }))
      .mockResolvedValueOnce(response({ ...fixture, buildLogs: [{ ...fixture.buildLogs[0], excerpt: "Revised", content: null, updatedAt: NOW }] }));
    await syncColosseumUpdates(db, PROJECT, { now: NOW, fetcher });
    await syncColosseumUpdates(db, PROJECT, { now: NOW, fetcher });
    expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get("cursor")).toBe("older");
    await syncColosseumUpdates(db, PROJECT, { now: NOW + 30 * 60_000, fetcher });
    expect(new URL(String(fetcher.mock.calls[2][0])).searchParams.has("cursor")).toBe(false);
    expect(await rows("SELECT external_id,body FROM hq_colosseum_updates ORDER BY external_id DESC")).toMatchObject([{ external_id: 900101, body: "Revised" }, { external_id: 900100 }]);
  });
  it("keeps saved content and cursor on failure, throttles retries, then recovers", async () => {
    const fetcher = vi.fn<ColosseumFetch>()
      .mockResolvedValueOnce(response({ ...fixture, nextCursor: "older" }))
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async () => response(fixture));
    await syncColosseumUpdates(db, PROJECT, { now: NOW, fetcher });
    expect(await syncColosseumUpdates(db, PROJECT, { now: NOW, fetcher })).toBe("failed");
    expect(await rows("SELECT cursor,last_error FROM hq_colosseum_update_sync")).toEqual([{ cursor: "older", last_error: "UNREACHABLE" }]);
    expect(await syncColosseumUpdates(db, PROJECT, { now: NOW + 1, fetcher })).toBe("skipped");
    expect(await rows("SELECT count(*)::int AS n FROM hq_colosseum_updates")).toEqual([{ n: 1 }]);
    expect(await syncColosseumUpdates(db, PROJECT, { now: NOW + 15 * 60_000, fetcher })).toBe("synced");
    expect(await rows("SELECT cursor,last_error FROM hq_colosseum_update_sync")).toEqual([{ cursor: null, last_error: null }]);
  });
  it("claims overlapping syncs once and does not duplicate records on later sweeps", async () => {
    const fetcher = transport();
    expect((await Promise.all([syncColosseumUpdates(db, PROJECT, { now: NOW, fetcher }), syncColosseumUpdates(db, PROJECT, { now: NOW, fetcher })])).sort()).toEqual(["skipped", "synced"]);
    await syncColosseumUpdates(db, PROJECT, { now: NOW + 30 * 60_000, fetcher });
    expect(await rows("SELECT count(*)::int AS n FROM hq_colosseum_updates")).toEqual([{ n: 1 }]);
  });
  it("enforces project and edition access before making an upstream request", async () => {
    const fetcher = transport();
    const input = { projectId: PROJECT, hackathonId: 91 };
    expect((await readColosseumHistory(member("outsider"), input, db, { now: NOW, fetcher })).linked).toBe(false);
    expect((await readColosseumHistory(operator, { ...input, hackathonId: 92 }, db, { now: NOW, fetcher })).linked).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await readColosseumHistory(member("history-owner"), input, db, { now: NOW, fetcher })).updates).toHaveLength(1);
  });
  it("paginates stored history by original date and id", async () => {
    const fetcher = vi.fn<ColosseumFetch>().mockImplementation(async () => response({ ...fixture, buildLogs: Array.from({ length: 15 }, (_, i) => ({ ...fixture.buildLogs[0], id: 900100 + i })) }));
    const input = { projectId: PROJECT, hackathonId: 91 };
    const first = await readColosseumHistory(operator, input, db, { now: NOW, fetcher });
    const second = await readColosseumHistory(operator, { ...input, cursor: first.nextCursor! }, db, { now: NOW, fetcher });
    expect(first.updates).toHaveLength(10); expect(second.updates).toHaveLength(5);
    expect(new Set([...first.updates, ...second.updates].map(update => update.externalId)).size).toBe(15);
    expect(second.nextCursor).toBeNull();
  });
  it("skips archived editions and honors the job time budget", async () => {
    const fetcher = transport();
    expect(await syncDueColosseumUpdates(db, { now: NOW, fetcher, deadlineMs: Date.now() })).toMatchObject({ synced: 0, stoppedOnBudget: true });
    await rows("UPDATE hq_hackathons SET archived_at=now() WHERE id=91");
    expect(await syncDueColosseumUpdates(db, { now: NOW, fetcher })).toMatchObject({ synced: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("can reapply the migration and cascades history when its project is deleted", async () => {
    await syncColosseumUpdates(db, PROJECT, { now: NOW, fetcher: transport() });
    await applySqlFile(pg, "builder-schema.sql");
    await rows("DELETE FROM hq_projects WHERE id=$1", [PROJECT]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_colosseum_updates")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_colosseum_update_sync")).toEqual([{ n: 0 }]);
  });
});
