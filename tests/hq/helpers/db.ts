// Shared PGlite bootstrap for tests that must follow the real migration path.
//
// scripts/hq/migrate.ts applies schema.sql, then applyUpgrades(), then
// member-auth-schema.sql, then builder-schema.sql, splitting each file on the
// statement terminator and running one statement per call over the Neon HTTP
// driver. This helper does exactly the same against PGlite, so a construct
// the HTTP driver cannot run (a `DO $$` block, a `;` inside a comment or
// string literal, two statements on one line) fails here before it fails in
// production. Tests that call pg.exec() bypass the splitter and would not
// catch those.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { applyUpgrades } from "@/scripts/hq/upgrades";

/** The exact splitter from scripts/hq/migrate.ts. Keep the regex identical. */
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

/** The full migration in scripts/hq/migrate.ts order. Safe to run twice. */
export async function applyMigrations(pg: PGlite): Promise<void> {
  await applySqlFile(pg, "schema.sql");
  await applyUpgrades({
    query: async (text) => (await pg.query(text)).rows as Record<string, unknown>[],
  });
  await applySqlFile(pg, "member-auth-schema.sql");
  await applySqlFile(pg, "builder-schema.sql");
}

/** A fresh in-process Postgres with the whole migration applied. */
export async function createMigratedDatabase(): Promise<PGlite> {
  const pg = new PGlite();
  await applyMigrations(pg);
  return pg;
}
