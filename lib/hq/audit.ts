import "server-only";
import {
  insertAuditEventStatement,
  toAuditEvent,
  type AuditEvent,
  type AuditEventInput,
} from "./audit-sql";
import type { BuilderQuery } from "./builder-db";

export type {
  AuditActor,
  AuditActorKind,
  AuditEvent,
  AuditEventInput,
  AuditEventKind,
  AuditMetadata,
} from "./audit-sql";

/**
 * Append structural metadata through the caller's transaction so the audit
 * commits or rolls back with the change. Never include note/update bodies;
 * those belong in protected entry and revision storage. No update or delete API.
 */
export async function recordAuditEvent(db: BuilderQuery, input: AuditEventInput): Promise<AuditEvent> {
  const statement = insertAuditEventStatement(input);
  const { rows } = await db.query(statement.text, statement.values);
  return toAuditEvent(rows[0]);
}
