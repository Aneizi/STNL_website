import "server-only";
import { recordAuditEvent, type AuditActor } from "./audit";
import { atomically, builderDatabase, type BuilderDatabase, type BuilderQuery } from "./builder-db";
import { BuilderError } from "./builder-types";
import type { PersonTag } from "./types";

/**
 * Admin-controlled account capabilities (hq_account_capabilities).
 *
 * A capability held by a public account is the only thing that ever opens a
 * privileged surface to it. It is never derived from a People role, a People
 * tag or the regular/member tier, and the two functions below are the only
 * writers of the table. Every grant and revocation lands in the audit trail
 * in the same transaction, so the row and its event commit or roll back
 * together.
 *
 * Who acted and who the row is attributed to are two different facts. An
 * admin granting Captain in Admin is both; a member redeeming a Captain
 * invitation (phase 4) is the actor, while the operator who created the
 * invitation is at most the `granted_by`. The caller supplies each
 * separately, so the trail never records an operator action nobody took.
 *
 * Reads take no cache: a revocation is visible on the next call.
 */

export const CAPABILITIES = ["captain"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** How People shows a capability: a locked tag with this label. */
export const CAPABILITY_LABELS: Record<Capability, string> = { captain: "Captain" };

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && (CAPABILITIES as readonly string[]).includes(value);
}

export type CapabilityGrant = {
  id: string;
  userId: string;
  /** The account's display name, for operator listings. */
  userName: string;
  capability: Capability;
  grantedByUserId: string | null;
  grantedAt: string;
  revokedByUserId: string | null;
  revokedAt: string | null;
  /** The reason given at grant time. A revocation's reason lives on its audit event. */
  reason: string | null;
};

export type CapabilityChange = {
  /**
   * Who is making the change, as the audit event records it. From
   * `requireUser()`, `currentMember()` or a verified job token, never from a
   * form field. A grant is not always an operator action: redeeming a Captain
   * invitation (phase 4) is the member's own act, and the trail must say so.
   */
  actor: AuditActor;
  /**
   * The operator the row is attributed to: `granted_by_user_id` on a grant,
   * `revoked_by_user_id` on a revocation. An `hq_users` id, so never a member
   * id; null when no operator stands behind the change (a member redeeming an
   * invitation an operator no longer owns, or a job).
   */
  byOperatorId: string | null;
  userId: string;
  capability: Capability;
  reason: string;
};

const GRANT_SELECT = `g.id::text AS id, g.user_id, b.name AS user_name, g.capability, g.granted_by_user_id::text AS granted_by_user_id,
  g.granted_at, g.revoked_by_user_id::text AS revoked_by_user_id, g.revoked_at, g.reason`;

const toIso = (value: unknown) => (value instanceof Date ? value : new Date(String(value))).toISOString();

function toGrant(row: Record<string, unknown>): CapabilityGrant {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    userName: String(row.user_name ?? ""),
    capability: row.capability as Capability,
    grantedByUserId: row.granted_by_user_id == null ? null : String(row.granted_by_user_id),
    grantedAt: toIso(row.granted_at),
    revokedByUserId: row.revoked_by_user_id == null ? null : String(row.revoked_by_user_id),
    revokedAt: row.revoked_at == null ? null : toIso(row.revoked_at),
    reason: row.reason == null ? null : String(row.reason),
  };
}

async function activeGrant(db: BuilderQuery, userId: string, capability: Capability): Promise<CapabilityGrant | null> {
  const { rows } = await db.query(
    `SELECT ${GRANT_SELECT} FROM hq_account_capabilities g JOIN hq_builder_profiles b ON b.id = g.user_id
     WHERE g.user_id = $1 AND g.capability = $2 AND g.revoked_at IS NULL`,
    [userId, capability],
  );
  return rows.length ? toGrant(rows[0]) : null;
}

/**
 * Grants a capability. Idempotent: an account that already holds it gets the
 * existing grant back and no second row or audit event is written. The insert
 * lands on the one-active-grant index, so two concurrent grants cannot both
 * succeed either.
 */
export async function grantCapability(db: BuilderQuery | BuilderDatabase, input: CapabilityChange): Promise<CapabilityGrant> {
  if (!isCapability(input.capability)) throw new BuilderError("Unknown capability.");
  return atomically(db, async (tx) => {
    const { rows: accounts } = await tx.query("SELECT name FROM hq_builder_profiles WHERE id = $1", [input.userId]);
    if (!accounts.length) throw new BuilderError("This account no longer exists.");
    const { rows: inserted } = await tx.query(
      `INSERT INTO hq_account_capabilities (user_id, capability, granted_by_user_id, reason)
       VALUES ($1, $2, $3::uuid, $4)
       ON CONFLICT (user_id, capability) WHERE revoked_at IS NULL DO NOTHING
       RETURNING id::text AS id, user_id, capability, granted_by_user_id::text AS granted_by_user_id, granted_at,
         revoked_by_user_id::text AS revoked_by_user_id, revoked_at, reason`,
      [input.userId, input.capability, input.byOperatorId, input.reason],
    );
    if (!inserted.length) {
      const existing = await activeGrant(tx, input.userId, input.capability);
      if (!existing) throw new BuilderError("The grant could not be read back. Try again.");
      return existing;
    }
    const grant = toGrant({ ...inserted[0], user_name: accounts[0].name });
    await recordAuditEvent(tx, {
      kind: "capability.granted",
      actor: input.actor,
      subjectUserId: input.userId,
      metadata: { capability: input.capability, grantId: grant.id, reason: input.reason },
    });
    return grant;
  });
}

/**
 * Revokes the active grant, keeping the row as history. Idempotent: without
 * an active grant nothing is written and null comes back. The reason is
 * recorded on the audit event; the row keeps the reason it was granted for.
 */
export async function revokeCapability(db: BuilderQuery | BuilderDatabase, input: CapabilityChange): Promise<CapabilityGrant | null> {
  if (!isCapability(input.capability)) throw new BuilderError("Unknown capability.");
  return atomically(db, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE hq_account_capabilities g SET revoked_at = now(), revoked_by_user_id = $3::uuid
       FROM hq_builder_profiles b
       WHERE g.user_id = $1 AND g.capability = $2 AND g.revoked_at IS NULL AND b.id = g.user_id
       RETURNING ${GRANT_SELECT}`,
      [input.userId, input.capability, input.byOperatorId],
    );
    if (!rows.length) return null;
    const grant = toGrant(rows[0]);
    await recordAuditEvent(tx, {
      kind: "capability.revoked",
      actor: input.actor,
      subjectUserId: input.userId,
      metadata: { capability: input.capability, grantId: grant.id, reason: input.reason },
    });
    return grant;
  });
}

/** The capabilities an account holds right now. Read fresh on every call. */
export async function listActiveCapabilities(userId: string, db: BuilderQuery = builderDatabase()): Promise<Capability[]> {
  const byUser = await listActiveCapabilitiesForUsers([userId], db);
  return byUser.get(userId) ?? [];
}

/**
 * The active capabilities of many accounts in one query, for list rendering.
 * Every requested id is present in the result, with an empty list when the
 * account holds nothing.
 */
export async function listActiveCapabilitiesForUsers(userIds: readonly string[], db: BuilderQuery = builderDatabase()): Promise<Map<string, Capability[]>> {
  const ids = [...new Set(userIds)];
  const result = new Map<string, Capability[]>(ids.map((id) => [id, []]));
  if (!ids.length) return result;
  const { rows } = await db.query(
    `SELECT user_id, capability FROM hq_account_capabilities
     WHERE revoked_at IS NULL AND user_id = ANY($1::text[]) ORDER BY user_id, capability`,
    [ids],
  );
  for (const row of rows) {
    if (isCapability(row.capability)) result.get(String(row.user_id))?.push(row.capability);
  }
  return result;
}

/**
 * Operator listing with grant and revocation metadata, newest grant first.
 *
 * `CapabilityGrant` is an operator-only shape: the rows carry the admin's
 * free-text `reason` plus the operator ids behind the grant and the
 * revocation. It takes no actor and checks nothing, because every caller is
 * already operator gated; a member-facing surface must map to a view model in
 * ./view-models instead (`CaptainLeaderboardView` for the phase 4
 * leaderboard), never hand these rows to a page a Captain can open.
 */
export async function listCapabilityGrants(
  filter: { capability: Capability; activeOnly?: boolean },
  db: BuilderQuery = builderDatabase(),
): Promise<CapabilityGrant[]> {
  if (!isCapability(filter.capability)) throw new BuilderError("Unknown capability.");
  const { rows } = await db.query(
    `SELECT ${GRANT_SELECT} FROM hq_account_capabilities g JOIN hq_builder_profiles b ON b.id = g.user_id
     WHERE g.capability = $1 ${filter.activeOnly ? "AND g.revoked_at IS NULL" : ""}
     ORDER BY g.granted_at DESC, g.id`,
    [filter.capability],
  );
  return rows.map(toGrant);
}

/**
 * The tags a People card shows: its editable role first, then one locked tag
 * per active capability of the linked account. Presentation only; nothing
 * reads a tag back to decide access.
 */
export function personTags(roleLabel: string, capabilities: readonly Capability[]): PersonTag[] {
  return [
    { kind: "role", label: roleLabel, protected: false },
    ...capabilities.map((capability): PersonTag => ({ kind: "capability", label: CAPABILITY_LABELS[capability], protected: true })),
  ];
}
