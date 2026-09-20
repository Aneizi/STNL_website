import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { applyUpgrades } from "./upgrades";

/** Both operations must use the same dedicated connection for the whole run. */
export interface MigrationConnection {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  execute(text: string): Promise<unknown>;
}

export type Migration = {
  id: string;
  checksum: string;
  apply(db: MigrationConnection): Promise<void>;
};

const LOCK = [0x48514d47, 1];
const BASELINE_ID = "0001-legacy-bootstrap";

function checksum(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Legacy files are frozen migration inputs. Add changes as new numbered SQL files. */
export function loadMigrations(directory = join(process.cwd(), "scripts/hq")): Migration[] {
  const legacyFiles = ["schema.sql", "upgrades.ts", "member-auth-schema.sql", "builder-schema.sql"];
  const legacy = legacyFiles.map((name) => readFileSync(join(directory, name), "utf8"));
  const migrations: Migration[] = [{
    id: BASELINE_ID,
    checksum: checksum([BASELINE_ID, ...legacyFiles.flatMap((name, index) => [name, legacy[index]])]),
    async apply(db) {
      await db.execute(legacy[0]);
      await applyUpgrades({ query: async (text) => (await db.query(text)).rows });
      await db.execute(legacy[2]);
      await db.execute(legacy[3]);
    },
  }];
  const migrationDirectory = join(directory, "migrations");
  for (const file of readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    if (!/^\d{4}-[a-z0-9][a-z0-9-]*\.sql$/.test(file)) throw new Error(`Invalid migration filename: ${file}`);
    const id = file.slice(0, -4);
    const sql = readFileSync(join(migrationDirectory, file), "utf8");
    migrations.push({ id, checksum: checksum([id, sql]), apply: async (db) => { await db.execute(sql); } });
  }
  return migrations;
}

/** Serialize runners, validate all applied history, then commit each new migration with its ledger row. */
export async function runMigrations(db: MigrationConnection, migrations: readonly Migration[]): Promise<string[]> {
  const versions = new Set<string>();
  for (const [index, migration] of migrations.entries()) {
    const version = migration.id.slice(0, 4);
    if (!/^\d{4}-[a-z0-9][a-z0-9-]*$/.test(migration.id)
      || !/^[a-f0-9]{64}$/.test(migration.checksum)
      || versions.has(version)
      || (index > 0 && migrations[index - 1].id >= migration.id)) {
      throw new Error(`Invalid or out-of-order migration: ${migration.id}`);
    }
    versions.add(version);
  }

  await db.query("SELECT pg_advisory_lock($1::int, $2::int)", LOCK);
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS hq_migrations (
      id text PRIMARY KEY,
      checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows: applied } = await db.query("SELECT id, checksum FROM hq_migrations ORDER BY id");
    for (const [index, row] of applied.entries()) {
      const migration = migrations[index];
      if (!migration || migration.id !== row.id) {
        throw new Error(`Migration history differs at ${String(row.id)}. Restore the complete ordered migration history before continuing.`);
      }
      if (migration.checksum !== row.checksum) {
        throw new Error(`Checksum mismatch for ${migration.id}. Applied migrations are immutable; add a new migration instead.`);
      }
    }

    const completed: string[] = [];
    for (const migration of migrations.slice(applied.length)) {
      await db.query("BEGIN");
      try {
        await migration.apply(db);
        await db.query("INSERT INTO hq_migrations (id, checksum) VALUES ($1, $2)", [migration.id, migration.checksum]);
        await db.query("COMMIT");
        completed.push(migration.id);
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
    }
    return completed;
  } finally {
    await db.query("SELECT pg_advisory_unlock($1::int, $2::int)", LOCK);
  }
}
