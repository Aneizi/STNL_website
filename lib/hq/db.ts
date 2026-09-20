import { Pool, type PoolClient, type QueryResultRow } from "pg";

export interface Query {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface Database extends Query {
  transaction<T>(work: (tx: Query) => Promise<T>): Promise<T>;
}

function createPool(url: string): Pool {
  const pool = new Pool({
    connectionString: url,
    max: 8,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });
  pool.on("error", () => console.error("HQ database idle connection failed"));
  return pool;
}

// All runtime database consumers, including Better Auth, share this lazy pool.
let pool: Pool | undefined;
export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    pool = createPool(url);
  }
  return pool;
}

async function inTransaction<T>(pool: Pool, work: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let releaseError: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // Discard a broken connection without hiding the original failure.
      releaseError = rollbackError instanceof Error ? rollbackError : new Error("Rollback failed");
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

export function getDatabase(): Database {
  return {
    query: (text, values) => getPool().query(text, values),
    transaction: (work) => inTransaction(getPool(), work),
  };
}

/** A statement stays unexecuted until awaited or included in an atomic batch. */
class Statement implements PromiseLike<QueryResultRow[]> {
  private result?: Promise<QueryResultRow[]>;

  constructor(
    readonly text: string,
    readonly values: unknown[],
    private readonly pool: Pool,
  ) {}

  private run(): Promise<QueryResultRow[]> {
    return this.result ??= this.pool.query(this.text, this.values).then((result) => result.rows);
  }

  then<T = QueryResultRow[], U = never>(
    onfulfilled?: ((rows: QueryResultRow[]) => T | PromiseLike<T>) | null,
    onrejected?: ((reason: unknown) => U | PromiseLike<U>) | null,
  ): Promise<T | U> {
    return this.run().then(onfulfilled, onrejected);
  }
}

function sqlForPool(pool: Pool) {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => new Statement(
    strings.reduce((text, part, i) => text + part + (i < values.length ? `$${i + 1}` : ""), ""),
    values,
    pool,
  );
  return Object.assign(sql, {
    query: async (text: string, values: unknown[] = []) => (await pool.query(text, values)).rows,
    transaction: (statements: readonly Statement[]) => inTransaction(pool, async (tx) => {
      const results: QueryResultRow[][] = [];
      for (const statement of statements) results.push((await tx.query(statement.text, statement.values)).rows);
      return results;
    }),
  });
}

/** Scripts use their explicit URL, independently of the application's pooled URL. */
export function createSql(url: string) {
  return sqlForPool(createPool(url));
}

let sql: ReturnType<typeof sqlForPool> | undefined;
export function getSql() {
  return sql ??= sqlForPool(getPool());
}
