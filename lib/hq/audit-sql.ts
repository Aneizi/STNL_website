/**
 * Pure SQL construction for the append-only audit trail (hq_audit_events).
 * No database handle, no network, no `server-only`, so tests can drive these
 * exact statements against a throwaway Postgres. The orchestration that runs
 * them lives in ./audit.
 *
 * There is deliberately no UPDATE and no DELETE here, and ./audit exposes
 * none either: an audit row is written once and then only read.
 */

/**
 * The one vocabulary of audit event kinds. Later phases extend this union
 * instead of inventing their own. `captain.assigned` and
 * `captain.unassigned` are reserved for phase 4.
 */
export const AUDIT_EVENT_KINDS = [
  "capability.granted",
  "capability.revoked",
  "identity.linked",
  "identity.unlinked",
  "identity.email_changed",
  "person.linked",
  "person.match_corrected",
  "captain.assigned",
  "captain.unassigned",
] as const;

export type AuditEventKind = (typeof AUDIT_EVENT_KINDS)[number];

export type AuditActorKind = "operator" | "member" | "system";

/** Who acted. The id comes from requireUser()/currentMember(), never from a form field; `system` has no id. */
export type AuditActor = { kind: AuditActorKind; id: string | null };

/**
 * Small, structural facts about the change: ids, a reason, counts. NEVER a
 * note body, an update body or any other free text a member wrote: those
 * belong in protected entry and revision storage, not in an audit log that
 * operators read in bulk.
 */
export type AuditMetadata = Record<string, unknown>;

export type AuditEventInput = {
  kind: AuditEventKind;
  actor: AuditActor;
  subjectUserId?: string | null;
  hackathonId?: number | null;
  projectId?: string | null;
  metadata?: AuditMetadata;
};

export type AuditEvent = {
  /** bigserial, carried as a string so it never passes through a JavaScript number. */
  id: string;
  kind: AuditEventKind;
  actor: AuditActor;
  subjectUserId: string | null;
  hackathonId: number | null;
  projectId: string | null;
  metadata: AuditMetadata;
  createdAt: string;
};

export type AuditEventFilter = {
  kind?: AuditEventKind;
  subjectUserId?: string;
  hackathonId?: number;
  projectId?: string;
};

export type AuditEventPage = {
  /** At most this many rows, newest first. */
  limit: number;
  /** The `nextCursor` of the previous page: rows older than this id. */
  cursor?: string | null;
};

export type Statement = { text: string; values: unknown[] };

export const AUDIT_SELECT =
  "id::text AS id, kind, actor_kind, actor_id, subject_user_id, hackathon_id, project_id::text AS project_id, metadata, created_at";

export function insertAuditEventStatement(input: AuditEventInput): Statement {
  return {
    text: `INSERT INTO hq_audit_events (kind, actor_kind, actor_id, subject_user_id, hackathon_id, project_id, metadata)
           VALUES ($1, $2, $3, $4, $5, $6::uuid, $7::jsonb) RETURNING ${AUDIT_SELECT}`,
    values: [
      input.kind,
      input.actor.kind,
      input.actor.id ?? null,
      input.subjectUserId ?? null,
      input.hackathonId ?? null,
      input.projectId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  };
}

/** Newest first, keyset-paged on the id so a page never shifts under a concurrent insert. */
export function listAuditEventsStatement(filter: AuditEventFilter, page: AuditEventPage): Statement {
  const where: string[] = [];
  const values: unknown[] = [];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  if (filter.kind) where.push(`kind = ${bind(filter.kind)}`);
  if (filter.subjectUserId) where.push(`subject_user_id = ${bind(filter.subjectUserId)}`);
  if (filter.hackathonId != null) where.push(`hackathon_id = ${bind(filter.hackathonId)}`);
  if (filter.projectId) where.push(`project_id = ${bind(filter.projectId)}::uuid`);
  if (page.cursor) where.push(`id < ${bind(page.cursor)}::bigint`);
  const limit = Math.max(1, Math.min(500, Math.floor(page.limit)));
  return {
    text: `SELECT ${AUDIT_SELECT} FROM hq_audit_events
           ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY id DESC LIMIT ${bind(limit)}`,
    values,
  };
}

const toIso = (value: unknown) => (value instanceof Date ? value : new Date(String(value))).toISOString();

export function toAuditEvent(row: Record<string, unknown>): AuditEvent {
  return {
    id: String(row.id),
    kind: row.kind as AuditEventKind,
    actor: { kind: row.actor_kind as AuditActorKind, id: row.actor_id == null ? null : String(row.actor_id) },
    subjectUserId: row.subject_user_id == null ? null : String(row.subject_user_id),
    hackathonId: row.hackathon_id == null ? null : Number(row.hackathon_id),
    projectId: row.project_id == null ? null : String(row.project_id),
    metadata: (typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata ?? {}) as AuditMetadata,
    createdAt: toIso(row.created_at),
  };
}
