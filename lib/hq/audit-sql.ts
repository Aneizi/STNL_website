/**
 * Pure INSERT construction and mapping for the append-only audit trail.
 * Execution lives in audit.ts; neither module exposes updates or deletion.
 */

/**
 * Shared vocabulary for persisted audit events.
 */
export const AUDIT_EVENT_KINDS = [
  "capability.granted",
  "capability.revoked",
  "identity.linked",
  "identity.unlinked",
  "identity.email_changed",
  "bot.consent_changed",
  "person.linked",
  "person.match_corrected",
  "captain.assigned",
  "captain.unassigned",
  "captain.invitation_created",
  "captain.invitation_revoked",
  "captain.invitation_redeemed",
  "project.imported",
  // A source attachment enriches the existing HQ project; it does not replace it.
  "project.created",
  "project.source_attached",
  "project.deleted",
  "person.deleted",
  // Audit reporting decisions, never entry bodies.
  "reporting.eligibility_changed",
  "reporting.entry_voided",
  "reporting.outcome_corrected",
  "reporting.period_closed",
] as const;

export type AuditEventKind = (typeof AUDIT_EVENT_KINDS)[number];

export type AuditActorKind = "operator" | "member" | "system";

/** Who acted. The id comes from requireUser()/currentMember(), never from a form field; `system` has no id. */
export type AuditActor = { kind: AuditActorKind; id: string | null };

/**
 * Structural ids, reasons and counts only. Member-authored note/update bodies
 * belong in protected entry and revision storage, never bulk audit logs.
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

type Statement = { text: string; values: unknown[] };

const AUDIT_SELECT =
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
