// Application tests use the production migration runner against in-memory
// Postgres. Legacy upgrade tests can still exercise the original replay path.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { BuilderDatabase, BuilderQuery } from "@/lib/hq/builder-db";
import { applyUpgrades } from "@/scripts/hq/upgrades";
import { loadMigrations, runMigrations, type MigrationConnection } from "@/scripts/hq/migrations";

/** The historical splitter, retained for legacy migration fixtures only. */
export function splitStatements(text: string): string[] {
  return text
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Reads one of the SQL files under scripts/hq. */
export function readSqlFile(name: string): string {
  return readFileSync(join(process.cwd(), "scripts/hq", name), "utf8");
}

/** Applies one SQL file statement by statement; returns how many ran. */
export async function applySqlFile(pg: PGlite, name: string): Promise<number> {
  const statements = splitStatements(readSqlFile(name));
  for (const statement of statements) await pg.query(statement);
  return statements.length;
}

/** Replays the pre-ledger upgrade path for historical compatibility tests. */
export async function applyLegacyMigrations(pg: PGlite): Promise<void> {
  await applySqlFile(pg, "schema.sql");
  await applyUpgrades({
    query: async (text) => (await pg.query(text)).rows as Record<string, unknown>[],
  });
  await applySqlFile(pg, "member-auth-schema.sql");
  await applySqlFile(pg, "builder-schema.sql");
}

export function pgliteMigrationConnection(pg: PGlite): MigrationConnection {
  return {
    query: async (text, values) => ({ rows: (await pg.query(text, values)).rows as Record<string, unknown>[] }),
    execute: (text) => pg.exec(text),
  };
}

/** The same checksummed, transactional migration path as npm run hq:migrate. */
export async function applyMigrations(pg: PGlite): Promise<void> {
  await runMigrations(pgliteMigrationConnection(pg), loadMigrations());
}

/** A fresh in-process Postgres with the whole migration applied. */
export async function createMigratedDatabase(): Promise<PGlite> {
  const pg = new PGlite();
  await applyMigrations(pg);
  return pg;
}

/**
 * The builder-side database handle over PGlite. PGlite owns one connection,
 * so complete transactions are serialized: concurrent application calls then
 * exercise real commit and rollback boundaries without interleaving BEGIN
 * statements on that single connection.
 */
export function pgliteBuilderDatabase(database: PGlite): BuilderDatabase {
  let queue: Promise<unknown> = Promise.resolve();
  const raw: BuilderQuery = {
    query: async (text, values) => ({ rows: (await database.query(text, values)).rows as Record<string, unknown>[] }),
  };
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work, work);
    queue = result.catch(() => undefined);
    return result;
  }
  return {
    query: (text, values) => serialized(() => raw.query(text, values)),
    transaction: (work) => serialized(async () => {
      await raw.query("BEGIN");
      try {
        const result = await work(raw);
        await raw.query("COMMIT");
        return result;
      } catch (error) {
        await raw.query("ROLLBACK");
        throw error;
      }
    }),
  };
}
