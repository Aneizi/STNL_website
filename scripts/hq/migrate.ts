import { Client } from "pg";
import { loadEnvLocal, requireEnv } from "./env";
import { loadMigrations, runMigrations } from "./migrations";

async function main() {
  loadEnvLocal();
  const migrations = loadMigrations();
  const client = new Client({
    connectionString: requireEnv("DATABASE_URL_UNPOOLED"),
    connectionTimeoutMillis: 10_000,
    statement_timeout: 300_000,
    lock_timeout: 30_000,
  });
  try {
    await client.connect();
    const applied = await runMigrations({
      query: (text, values) => client.query(text, values),
      execute: (text) => client.query(text),
    }, migrations);
    console.log(applied.length ? `Applied: ${applied.join(", ")}` : "HQ database is up to date.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
