import "server-only";
import {
  insertAuditEventStatement,
  listAuditEventsStatement,
  toAuditEvent,
  type AuditEvent,
  type AuditEventFilter,
  type AuditEventInput,
  type AuditEventPage,
} from "./audit-sql";
import { builderDatabase, type BuilderQuery } from "./builder-db";

export type {
  AuditActor,
  AuditActorKind,
  AuditEvent,
  AuditEventFilter,
  AuditEventInput,
  AuditEventKind,
  AuditEventPage,
  AuditMetadata,
} from "./audit-sql";

/**
 * Append-only metadata audit. Two entry points, insert and read, and nothing
 * else: this module has no update and no delete, and a test asserts that.
 *
 * `recordAuditEvent` writes through the query handle it is given. Inside a
 * transaction callback that is the transaction client, so the event commits
 * or rolls back together with the grant, link or assignment it describes.
 *
 * Metadata is small and structural (ids, a reason, counts). Note bodies and
 * update bodies never go here; they belong in protected entry and revision
 * storage with their own audience rules.
 */
export async function recordAuditEvent(db: BuilderQuery, input: AuditEventInput): Promise<AuditEvent> {
  const statement = insertAuditEventStatement(input);
  const { rows } = await db.query(statement.text, statement.values);
  return toAuditEvent(rows[0]);
}

/**
 * Operator listing, newest first. `nextCursor` is null on the last page.
 *
 * `AuditEvent` is an operator-only shape: the rows name the actor behind every
 * change and carry the reason an admin typed. This takes no actor and checks
 * nothing, because every caller is already operator gated and because a
 * session read here would make ./member-auth, which writes events through
 * `recordAuditEvent`, import this module's session graph in a cycle. A member
 * surface therefore never calls this; it renders a view model built from the
 * records themselves.
 */
export async function listAuditEvents(
  filter: AuditEventFilter,
  page: AuditEventPage,
  db: BuilderQuery = builderDatabase(),
): Promise<{ events: AuditEvent[]; nextCursor: string | null }> {
  const statement = listAuditEventsStatement(filter, page);
  const { rows } = await db.query(statement.text, statement.values);
  const events = rows.map(toAuditEvent);
  const full = events.length >= Math.max(1, Math.min(500, Math.floor(page.limit)));
  return { events, nextCursor: full && events.length ? events[events.length - 1].id : null };
}
