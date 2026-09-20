import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pg: null as PGlite | null,
  pools: [] as Array<{ options: Record<string, unknown> }>,
  calls: [] as Array<{ connection: "pool" | number; text: string; values: unknown[] }>,
  connections: 0,
  releases: [] as Array<Error | undefined>,
  failCommand: null as string | null,
  rollbackError: null as Error | null,
  connectError: null as Error | null,
  authDatabase: null as unknown,
}));

vi.mock("server-only", () => ({}));
vi.mock("better-auth", () => ({ betterAuth: (options: { database: unknown }) => {
  state.authDatabase = options.database;
  return {};
} }));
vi.mock("pg", () => ({
  Pool: class {
    constructor(readonly options: Record<string, unknown>) { state.pools.push(this); }
    on() { return this; }
    async query(text: string, values: unknown[] = []) {
      state.calls.push({ connection: "pool", text, values });
      return state.pg!.query(text, values);
    }
    async connect() {
      if (state.connectError) throw state.connectError;
      const connection = ++state.connections;
      return {
        async query(text: string, values: unknown[] = []) {
          state.calls.push({ connection, text, values });
          if (text === state.failCommand) throw new Error(`Failed ${text}`);
          if (text === "ROLLBACK" && state.rollbackError) throw state.rollbackError;
          return state.pg!.query(text, values);
        },
        release(error?: Error) { state.releases.push(error); },
      };
    }
  },
}));

beforeAll(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  state.pg = new PGlite();
  await state.pg.exec(`CREATE TABLE db_probe (
    body text UNIQUE, payload jsonb DEFAULT '{}', enabled boolean DEFAULT true, happened_at timestamptz DEFAULT now()
  )`);
});

beforeEach(async () => {
  await state.pg!.exec("ROLLBACK; TRUNCATE db_probe");
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", "postgres://test.invalid/shared-pool");
  state.pools.length = 0;
  state.calls.length = 0;
  state.connections = 0;
  state.releases.length = 0;
  state.failCommand = null;
  state.rollbackError = null;
  state.connectError = null;
  state.authDatabase = null;
});

afterAll(async () => { await state.pg?.close(); vi.unstubAllEnvs(); });

describe("shared PostgreSQL transport", () => {
  it("can be imported without configuration and fails only when a pool is needed", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const db = await import("@/lib/hq/db");
    expect(state.pools).toHaveLength(0);
    db.getDatabase();
    expect(state.pools).toHaveLength(0);
    expect(() => db.getSql()).toThrow("DATABASE_URL is not set");
  });

  it("parameterizes a lazy statement, executes it once across awaits, and preserves PostgreSQL value types", async () => {
    const { getSql } = await import("@/lib/hq/db");
    const sql = getSql();
    const body = "'); DROP TABLE db_probe; --";
    const payload = { nested: [1, true, null] };
    const date = new Date("2026-09-20T12:34:56.789Z");
    const statement = sql`INSERT INTO db_probe (body,payload,happened_at)
      VALUES (${body},${JSON.stringify(payload)}::jsonb,${date}) RETURNING *`;
    expect(state.calls).toHaveLength(0);
    const [first, second] = await Promise.all([Promise.resolve(statement), Promise.resolve(statement)]);
    expect(await statement).toBe(first);
    expect(second).toBe(first);
    expect(first).toEqual([{ body, payload, enabled: true, happened_at: date }]);
    expect(first[0].happened_at).toBeInstanceOf(Date);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].text).not.toContain(body);
    expect(state.calls[0].values).toEqual([body, JSON.stringify(payload), date]);
    expect((await state.pg!.query("SELECT count(*)::int AS count FROM db_probe")).rows).toEqual([{ count: 1 }]);
  });

  it("runs an entire statement batch on one connection and returns a row array per statement", async () => {
    const { getSql } = await import("@/lib/hq/db");
    const sql = getSql();
    const statements = [
      sql`INSERT INTO db_probe (body) VALUES (${"first"}) RETURNING body`,
      sql`INSERT INTO db_probe (body) SELECT body || ${"-second"} FROM db_probe RETURNING body`,
    ];
    expect(state.calls).toHaveLength(0);
    expect(await sql.transaction(statements)).toEqual([[{ body: "first" }], [{ body: "first-second" }]]);
    expect(state.calls.map(({ connection }) => connection)).toEqual([1, 1, 1, 1]);
    expect(state.calls[0].text).toBe("BEGIN");
    expect(state.calls.at(-1)?.text).toBe("COMMIT");
    expect(state.releases).toEqual([undefined]);
  });

  it("rolls back every write in a failed batch and releases its connection", async () => {
    const { getSql } = await import("@/lib/hq/db");
    const sql = getSql();
    await expect(sql.transaction([
      sql`INSERT INTO db_probe (body) VALUES (${"duplicate"})`,
      sql`INSERT INTO db_probe (body) VALUES (${"duplicate"})`,
    ])).rejects.toThrow(/unique constraint/);
    expect((await state.pg!.query("SELECT * FROM db_probe")).rows).toEqual([]);
    expect(state.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(state.releases).toEqual([undefined]);
    expect(state.calls.every(({ connection }) => connection === 1)).toBe(true);
  });

  it("shares one pool across tags, callback services, the builder wrapper and Better Auth", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://hq-test.example");
    vi.stubEnv("BETTER_AUTH_SECRET", "test-only-shared-pool-secret-at-least-32-characters");
    const { getDatabase, getPool, getSql } = await import("@/lib/hq/db");
    const { builderDatabase, atomically } = await import("@/lib/hq/builder-db");
    const pool = getPool();
    const { getAuth } = await import("@/lib/hq/member-auth");
    getAuth();
    expect(state.authDatabase).toBe(pool);
    expect(await getSql().query("SELECT 1::int AS value")).toEqual([{ value: 1 }]);
    expect((await getDatabase().query("SELECT 2::int AS value")).rows).toEqual([{ value: 2 }]);
    expect((await builderDatabase().query("SELECT 3::int AS value")).rows).toEqual([{ value: 3 }]);
    const result = await builderDatabase().transaction(async (tx) => atomically(tx, async (sameTx) => {
      expect(sameTx).toBe(tx);
      return (await sameTx.query("INSERT INTO db_probe (body) VALUES ($1) RETURNING body", ["callback"])).rows;
    }));
    expect(result).toEqual([{ body: "callback" }]);
    expect(state.pools).toEqual([pool]);
    expect(state.connections).toBe(1);
    expect(state.releases).toEqual([undefined]);
  });

  it.each(["BEGIN", "COMMIT"])("releases the client when %s fails", async (command) => {
    const { getDatabase } = await import("@/lib/hq/db");
    state.failCommand = command;
    await expect(getDatabase().transaction(async (tx) => {
      await tx.query("INSERT INTO db_probe (body) VALUES ('callback')");
    })).rejects.toThrow(`Failed ${command}`);
    expect(state.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(state.releases).toEqual([undefined]);
    expect((await state.pg!.query("SELECT * FROM db_probe")).rows).toEqual([]);
  });

  it("discards a client whose rollback fails without replacing the original service error", async () => {
    const { getDatabase } = await import("@/lib/hq/db");
    const original = new Error("Service failed");
    state.rollbackError = new Error("Connection failed during rollback");
    await expect(getDatabase().transaction(async () => { throw original; })).rejects.toBe(original);
    expect(state.releases).toEqual([state.rollbackError]);
  });

  it("does not try to release a connection it never acquired", async () => {
    const { getDatabase } = await import("@/lib/hq/db");
    state.connectError = new Error("Pool unavailable");
    await expect(getDatabase().transaction(async () => undefined)).rejects.toBe(state.connectError);
    expect(state.calls).toEqual([]);
    expect(state.releases).toEqual([]);
  });
});
