import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Query } from "@/lib/hq/db";
import { hitRateLimit, purgeExpiredLoginState, releaseRateLimit } from "@/lib/hq/rate-limit";
import { readSqlFile } from "./helpers/db";

vi.mock("server-only", () => ({}));

let pg: PGlite;
let db: Query;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readSqlFile("schema.sql"));
  db = { query: (text, values) => pg.query<Record<string, unknown>>(text, values) };
});
beforeEach(async () => { await pg.exec("ROLLBACK; TRUNCATE hq_login_limits, hq_login_attempts RESTART IDENTITY"); });
afterAll(async () => { await pg.close(); });

describe("shared fixed-window rate limits", () => {
  it("admits only the allowed burst, isolates keys, and bounds the stored counter after repeated blocks", async () => {
    const results = await Promise.all(Array.from({ length: 100 }, () => hitRateLimit(db, "operator:burst", { max: 3 })));
    expect(results.filter(({ allowed }) => allowed)).toHaveLength(3);
    expect(Math.max(...results.map(({ count }) => count))).toBe(4);
    expect((await pg.query("SELECT key,count FROM hq_login_limits")).rows).toEqual([{ key: "operator:burst", count: 4 }]);
    expect(await hitRateLimit(db, "operator:unrelated", { max: 3 })).toEqual({ allowed: true, count: 1 });
  });

  it("retains the strict expiration boundary and resets only once the configured window is past", async () => {
    // PostgreSQL now() stays fixed inside this transaction, making the exact
    // boundary deterministic without replacing application time or SQL.
    await pg.exec("BEGIN");
    try {
      await pg.query("INSERT INTO hq_login_limits VALUES ('boundary',2,now()-interval '5 minutes')");
      expect(await hitRateLimit(db, "boundary", { max: 2, windowMinutes: 5 })).toEqual({ allowed: false, count: 3 });
      await pg.query("UPDATE hq_login_limits SET window_start=window_start-interval '1 microsecond' WHERE key='boundary'");
      expect(await hitRateLimit(db, "boundary", { max: 2, windowMinutes: 5 })).toEqual({ allowed: true, count: 1 });
      expect((await pg.query("SELECT window_start=now() AS reset FROM hq_login_limits WHERE key='boundary'")).rows)
        .toEqual([{ reset: true }]);
    } finally { await pg.exec("ROLLBACK"); }
  });

  it("resets the successful user's bucket but credits only one attempt to its shared IP bucket", async () => {
    await Promise.all(Array.from({ length: 3 }, () => hitRateLimit(db, "ip:office", { max: 20 })));
    await hitRateLimit(db, "user:alex@office", { max: 5 });
    const before = (await pg.query("SELECT window_start FROM hq_login_limits WHERE key='ip:office'")).rows;
    await releaseRateLimit(db, "user:alex@office", true);
    await releaseRateLimit(db, "ip:office");
    expect((await pg.query("SELECT key,count FROM hq_login_limits ORDER BY key")).rows).toEqual([{ key: "ip:office", count: 2 }]);
    expect((await pg.query("SELECT window_start FROM hq_login_limits WHERE key='ip:office'")).rows).toEqual(before);
    for (let i = 0; i < 4; i++) await releaseRateLimit(db, "ip:office");
    await releaseRateLimit(db, "nonexistent");
    expect((await pg.query("SELECT key,count FROM hq_login_limits")).rows).toEqual([{ key: "ip:office", count: 0 }]);
    expect(await hitRateLimit(db, "user:alex@office", { max: 5 })).toEqual({ allowed: true, count: 1 });
  });

  it("purges only the oldest bounded batch while preserving current and exact-cutoff records", async () => {
    const now = Date.parse("2030-01-03T00:00:00Z");
    await pg.exec(`INSERT INTO hq_login_limits (key,count,window_start)
      SELECT 'stale-' || n, 1, '2030-01-01T00:00:00Z'::timestamptz + n * interval '1 minute' FROM generate_series(1,4) n;
      INSERT INTO hq_login_limits VALUES ('cutoff',1,'2030-01-02T00:00:00Z'),('current',1,'2030-01-03T00:00:00Z');
      INSERT INTO hq_login_attempts (username,ip,success,created_at)
        SELECT key,'test',false,window_start FROM hq_login_limits;`);
    await purgeExpiredLoginState(db, now, 2.9);
    const expected = ["current", "cutoff", "stale-3", "stale-4"];
    expect((await pg.query<{ key: string }>("SELECT key FROM hq_login_limits ORDER BY key")).rows.map(({ key }) => key)).toEqual(expected);
    expect((await pg.query<{ username: string }>("SELECT username FROM hq_login_attempts ORDER BY username")).rows.map(({ username }) => username)).toEqual(expected);
    await purgeExpiredLoginState(db, now, 2);
    await purgeExpiredLoginState(db, now, 2);
    expect((await pg.query("SELECT key FROM hq_login_limits ORDER BY key")).rows).toEqual([{ key: "current" }, { key: "cutoff" }]);
    expect((await pg.query("SELECT count(*)::int AS count FROM hq_login_attempts")).rows).toEqual([{ count: 2 }]);
  });

  it("caps an oversized purge request at 5,000 records per table", async () => {
    await pg.exec(`INSERT INTO hq_login_limits (key,count,window_start)
      SELECT 'stale-' || n, 1, '2000-01-01' FROM generate_series(1,5002) n;
      INSERT INTO hq_login_attempts (username,ip,success,created_at)
        SELECT key,'test',false,window_start FROM hq_login_limits;`);
    await purgeExpiredLoginState(db, Date.parse("2030-01-03T00:00:00Z"), 100_000);
    expect((await pg.query("SELECT count(*)::int AS count FROM hq_login_limits")).rows).toEqual([{ count: 2 }]);
    expect((await pg.query("SELECT count(*)::int AS count FROM hq_login_attempts")).rows).toEqual([{ count: 2 }]);
  });
});
