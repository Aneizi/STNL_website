import 'server-only';
import { Pool } from 'pg';

// The public-account (builder side) database handle: a pg pool with a
// callback transaction, so a service can read and then write atomically in
// one transaction. Split from builder-store.ts so that modules the store
// imports (crm-identity.ts, audit.ts, capabilities.ts) can take the pool
// without an import cycle; builder-store.ts re-exports everything here, so
// existing import paths keep working.

type Row = Record<string, unknown>;
export interface BuilderQuery { query(text: string, values?: unknown[]): Promise<{ rows: Row[] }> }
export interface BuilderDatabase extends BuilderQuery {
  transaction<T>(work: (db: BuilderQuery) => Promise<T>): Promise<T>;
}

let database: BuilderDatabase | undefined;

/** The shared public-account pool; also serves lib/hq/identity.ts. Separate from Better Auth's pool. */
export function builderDatabase(): BuilderDatabase {
  if (database) return database;
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, idleTimeoutMillis: 20_000, connectionTimeoutMillis: 10_000 });
  database = {
    query: (text, values) => pool.query(text, values),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
  };
  return database;
}

/** Runs `work` in a transaction of `db`'s own, or inside the caller's when `db` already is a transaction client. */
export function atomically<T>(db: BuilderQuery | BuilderDatabase, work: (tx: BuilderQuery) => Promise<T>): Promise<T> {
  return 'transaction' in db ? db.transaction(work) : work(db);
}
