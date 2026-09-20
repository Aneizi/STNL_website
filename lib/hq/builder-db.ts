import 'server-only';
import { getDatabase, type Database, type Query } from './db';

// Keep the service-facing names while all callers share the same transport.
export type BuilderQuery = Query;
export type BuilderDatabase = Database;
export function builderDatabase(): BuilderDatabase {
  return getDatabase();
}

/** Reuse the caller's transaction when given a transaction client. */
export function atomically<T>(db: BuilderQuery | BuilderDatabase, work: (tx: BuilderQuery) => Promise<T>): Promise<T> {
  return 'transaction' in db ? db.transaction(work) : work(db);
}
