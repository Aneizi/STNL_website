// Targeted role setup, independent of unrelated schema upgrades.
import { createSql } from "../../lib/hq/db";
import { ensureBuilderRole } from "../../lib/hq/builder-role";
import { loadEnvLocal, requireEnv } from "./env";

async function main() {
  loadEnvLocal();
  const sql = createSql(requireEnv("DATABASE_URL"));
  const roleId = await ensureBuilderRole({ query: (text) => sql.query(text) });
  if (!roleId) throw new Error("Builder is already configured as a judge role. No existing role was changed.");
  console.log("Builder role is ready in HQ People.");
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error instanceof Error ? error.message : "Could not set up the Builder role.");
  process.exit(1);
});
