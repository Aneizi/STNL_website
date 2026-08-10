import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { Pool } from "pg";

// Lazy so `next build` succeeds in environments without DATABASE_URL.
let sql: NeonQueryFunction<false, false> | null = null;

type LazyQuery = { text: string; params: unknown[] };

/**
 * Local-development driver.
 *
 * The Neon serverless client speaks HTTP to Neon's own endpoint rather than
 * the Postgres wire protocol, so it cannot reach a Postgres running on this
 * machine. This adapter exposes the same three things the app uses — the
 * tagged template, .query() and .transaction() — over node-postgres, which
 * shares Neon's `pg-types` value parsing. It is only ever selected for a
 * localhost URL outside production.
 */
function localSql(url: string): NeonQueryFunction<false, false> {
  const pool = new Pool({ connectionString: url });
  const run = async (text: string, params: unknown[]) => (await pool.query(text, params)).rows;

  // Queries execute on await, so one can be built now and run later inside
  // transaction() — the contract lib/hq/actions/util.ts relies on.
  const lazy = (text: string, params: unknown[]) => ({
    text,
    params,
    then: (ok?: (rows: unknown[]) => unknown, fail?: (err: unknown) => unknown) =>
      run(text, params).then(ok, fail),
    catch: (fail?: (err: unknown) => unknown) => run(text, params).catch(fail),
    finally: (done?: () => void) => run(text, params).finally(done),
  });

  const tagged = (strings: TemplateStringsArray, ...values: unknown[]) =>
    lazy(
      strings.reduce(
        (acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ""),
        "",
      ),
      values,
    );

  return Object.assign(tagged, {
    query: (text: string, params: unknown[] = []) => run(text, params),
    transaction: async (queries: LazyQuery[]) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const results: unknown[][] = [];
        for (const q of queries) results.push((await client.query(q.text, q.params)).rows);
        await client.query("COMMIT");
        return results;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
  }) as unknown as NeonQueryFunction<false, false>;
}

function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

/** Picks the driver a URL needs. Shared with scripts/hq/{migrate,seed}.ts. */
export function createSql(url: string): NeonQueryFunction<false, false> {
  return isLocalUrl(url) ? localSql(url) : neon(url);
}

export function getSql(): NeonQueryFunction<false, false> {
  if (!sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    // Belt and braces: a production deployment always gets the Neon client,
    // whatever the URL looks like.
    sql =
      process.env.NODE_ENV !== "production" && isLocalUrl(url) ? localSql(url) : neon(url);
  }
  return sql;
}
