// Clears the dashboard's operational data so HQ can be used for real after a
// round of testing, without dropping the schema, the logins or the classifiers.
//
// Destructive, so it names its target out loud and does nothing without --yes.
// The manifest of what is cleared and what survives lives in ./reset-statements.
//
// Usage:  npm run hq:reset            (dry run — prints the target and counts)
//         npm run hq:reset -- --yes
import { createSql } from "../../lib/hq/db";
import { loadEnvLocal, requireEnv } from "./env";
import { CLEAR_TABLES, KEEP_TABLES, RESET_STATEMENTS } from "./reset-statements";

/** "host / database", so the operator can see which database is about to change. */
function describeTarget(url: string): string {
  try {
    const { hostname, pathname } = new URL(url);
    return `${hostname}${pathname}`;
  } catch {
    return "unparseable DATABASE_URL_UNPOOLED";
  }
}

async function counts(
  sql: ReturnType<typeof createSql>,
  tables: readonly string[],
): Promise<Array<[string, number]>> {
  const rows: Array<[string, number]> = [];
  for (const table of tables) {
    const [row] = (await sql.query(`SELECT count(*)::int AS n FROM ${table}`)) as Array<{
      n: number;
    }>;
    rows.push([table, Number(row?.n ?? 0)]);
  }
  return rows;
}

function report(title: string, rows: Array<[string, number]>) {
  console.log(`\n${title}`);
  for (const [table, n] of rows) {
    console.log(`  ${table.padEnd(24)} ${n}`);
  }
}

async function main() {
  const confirmed = process.argv.includes("--yes");
  loadEnvLocal();
  const url = requireEnv("DATABASE_URL_UNPOOLED");
  const sql = createSql(url);

  console.log(`\n  TARGET: ${describeTarget(url)}\n`);

  const before = await counts(sql, CLEAR_TABLES);
  const kept = await counts(sql, KEEP_TABLES);
  report("Will be cleared:", before);
  report("Will be kept:", kept);

  if (!confirmed) {
    console.log(
      "\nDry run — nothing was changed. Check the target above, then re-run with --yes.",
    );
    return;
  }

  // Sequential rather than one transaction: lib/hq/db.ts's two drivers disagree
  // about whether .query() is lazy, so batching them would quietly run outside
  // a transaction on one of them. The statements delete children before
  // parents, so an interrupted run leaves the database consistent — just
  // partly cleared — and re-running finishes the job.
  for (const text of RESET_STATEMENTS) await sql.query(text);

  report("Cleared:", await counts(sql, CLEAR_TABLES));
  console.log(
    "\nDone. Logins, classifiers and settings are untouched; the Luma calendar" +
      "\nre-mirrors on the next load of /hq/events.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
