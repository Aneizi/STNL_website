// Applies scripts/hq/schema.sql to the Neon database, then the in-code
// upgrades for databases that predate the demo-day integrity constraints.
// The HTTP driver runs one statement per call, so the file is split on
// statement-terminating semicolons (the schema has no $$ bodies).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSql } from "../../lib/hq/db";
import { loadEnvLocal, requireEnv } from "./env";
import { applyUpgrades } from "./upgrades";

async function main() {
  loadEnvLocal();
  // Direct (unpooled) connection for DDL, per Neon guidance.
  const sql = createSql(requireEnv("DATABASE_URL_UNPOOLED"));

  const schema = readFileSync(join(process.cwd(), "scripts/hq/schema.sql"), "utf8");
  const statements = schema
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await sql.query(statement);
  }
  await applyUpgrades({ query: (text) => sql.query(text) });
  console.log(`Applied ${statements.length} statements.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
