import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { recordAuditEvent } from "./audit";
import { atomically, builderDatabase, type BuilderDatabase, type BuilderQuery } from "./builder-db";
import { BuilderError } from "./builder-types";
import { grantCapability, listActiveCapabilitiesForUsers } from "./capabilities";
import { isVerifiedAccount } from "./identity";

/**
 * The Captain invitation half of the Captain service (contracts.md's
 * "Captain service" row). T4.4 (assignment: `assignCaptain`, `unassignCaptain`)
 * and T4.5 (`leaderboard`) extend this same file; everything below is scoped
 * to invitations only and is written to leave room rather than anticipate
 * either.
 *
 * Two tables, both from T4.1 (scripts/hq/builder-schema.sql, read the comment
 * blocks above them before touching this file): `hq_captain_invitations` and
 * `hq_captain_invitation_redemptions`. A redemption row's `user_id` is
 * nullable at the schema level (ON DELETE SET NULL, so a deleted account's
 * seat is never replenished) but this module must never itself *insert* one
 * without a real user_id — a NULL one would consume a seat, grant nobody, and
 * (NULL never equalling NULL) be repeatable past the UNIQUE constraint.
 */

/** Far beyond any realistic Captain cohort for one edition; finite so a typo (an extra zero) fails loudly instead of becoming unlimited. */
const MAX_REDEMPTIONS = 500;
/** Far beyond one edition's timeline; the same reasoning as MAX_REDEMPTIONS applies at least as strongly to a bearer token's lifetime — an uncapped "valid for" turns a typo into an effectively permanent Captain link. */
const MAX_VALIDITY_DAYS = 365;
const MAX_LABEL_LENGTH = 200;

/** The hashCode pattern from builder-store.ts, without its human-typed-code normalization: a base64url token is already exact and case-sensitive, so upper-casing or stripping characters would corrupt it. */
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const toIso = (value: unknown) => (value instanceof Date ? value : new Date(String(value))).toISOString();

export type CaptainInvitationRedeemer = {
  /** Null when the account was deleted after redeeming; the seat it used still counts (schema comment on hq_captain_invitation_redemptions). */
  userId: string | null;
  name: string | null;
  redeemedAt: string;
};

/** The operator listing shape: everything Admin needs to inspect usage and redeemers. Never returned to a landing page. */
export type CaptainInvitationListing = {
  id: string;
  label: string | null;
  maxRedemptions: number;
  usedCount: number;
  expiresAt: string;
  createdAt: string;
  createdByUserId: string | null;
  createdByName: string | null;
  revokedAt: string | null;
  revokedByUserId: string | null;
  state: "active" | "expired" | "revoked" | "full";
  redeemers: CaptainInvitationRedeemer[];
};

type RedeemerRow = { userId: unknown; name: unknown; redeemedAt: unknown };

function toRedeemer(row: RedeemerRow): CaptainInvitationRedeemer {
  return {
    userId: row.userId == null ? null : String(row.userId),
    name: row.name == null ? null : String(row.name),
    redeemedAt: toIso(row.redeemedAt),
  };
}

/** Shared by create, revoke and list: the columns below are aliased identically in every query that returns an invitation row. */
function toListing(row: Record<string, unknown>): CaptainInvitationListing {
  const maxRedemptions = Number(row.max_redemptions);
  const raw = typeof row.redemptions === "string" ? JSON.parse(row.redemptions) : (row.redemptions ?? []);
  const redeemers = (raw as RedeemerRow[]).map(toRedeemer);
  const usedCount = redeemers.length;
  const revokedAt = row.revoked_at == null ? null : toIso(row.revoked_at);
  const expiresAt = toIso(row.expires_at);
  const expired = new Date(expiresAt).getTime() <= Date.now();
  const state: CaptainInvitationListing["state"] =
    revokedAt != null ? "revoked" : expired ? "expired" : usedCount >= maxRedemptions ? "full" : "active";
  return {
    id: String(row.id),
    label: row.label == null ? null : String(row.label),
    maxRedemptions,
    usedCount,
    expiresAt,
    createdAt: toIso(row.created_at),
    createdByUserId: row.created_by_user_id == null ? null : String(row.created_by_user_id),
    createdByName: row.created_by_name == null ? null : String(row.created_by_name),
    revokedAt,
    revokedByUserId: row.revoked_by_user_id == null ? null : String(row.revoked_by_user_id),
    state,
    redeemers,
  };
}

/** The scalar subquery every mutating statement below reuses to fill in the creator's current display name. */
const CREATED_BY_NAME = `(SELECT display_name FROM hq_users WHERE id = created_by_user_id)`;
/** The scalar subquery a single-row mutation (create, revoke) uses for its redeemer list, aliased to match the GROUP BY version in listCaptainInvitations. */
const REDEMPTIONS_SUBQUERY = (idExpr: string) => `(
  SELECT COALESCE(json_agg(json_build_object('userId', r.user_id, 'name', b.name, 'redeemedAt', r.redeemed_at) ORDER BY r.redeemed_at), '[]')
  FROM hq_captain_invitation_redemptions r LEFT JOIN hq_builder_profiles b ON b.id = r.user_id
  WHERE r.invitation_id = ${idExpr}
) AS redemptions`;

function validateMaxRedemptions(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_REDEMPTIONS) {
    throw new BuilderError(`Maximum connected accounts must be a whole number from 1 to ${MAX_REDEMPTIONS}.`);
  }
  return value;
}

/**
 * Strictly in the future and finite: a non-expiring or already-past
 * invitation is refused rather than silently clamped. `expiresAt` wins if a
 * caller somehow supplies both; the Admin form only ever sends one.
 */
function resolveExpiry(input: { expiresInDays?: number; expiresAt?: string }): Date {
  const raw =
    input.expiresAt != null
      ? new Date(input.expiresAt)
      : input.expiresInDays != null
        ? new Date(Date.now() + input.expiresInDays * 86_400_000)
        : null;
  if (!raw || !Number.isFinite(raw.getTime())) throw new BuilderError("Give a valid expiry.");
  if (raw.getTime() <= Date.now()) throw new BuilderError("Expiry must be in the future.");
  if (raw.getTime() - Date.now() > MAX_VALIDITY_DAYS * 86_400_000) throw new BuilderError(`Expiry must be within ${MAX_VALIDITY_DAYS} days.`);
  return raw;
}

export type CaptainInvitationCreation = { token: string; invitation: CaptainInvitationListing };

/**
 * Creates a Captain invitation and returns its plaintext bearer token once.
 * The token is 32 random bytes, base64url encoded (so it passes ID_SEGMENT in
 * lib/hq/member-routes.ts unchanged); only its sha256 hex digest is stored.
 * The insert, its RETURNING and the `captain.invitation_created` audit event
 * share one transaction; the token itself never appears in the event or in
 * any column.
 */
export async function createCaptainInvitation(
  db: BuilderQuery | BuilderDatabase,
  input: { actorOperatorId: string; label?: string | null; maxRedemptions: number; expiresInDays?: number; expiresAt?: string },
): Promise<CaptainInvitationCreation> {
  const maxRedemptions = validateMaxRedemptions(input.maxRedemptions);
  const expiresAt = resolveExpiry(input);
  const label = input.label?.trim() || null;
  if (label && label.length > MAX_LABEL_LENGTH) throw new BuilderError(`Label must be ${MAX_LABEL_LENGTH} characters or fewer.`);

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);

  const invitation = await atomically(db, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO hq_captain_invitations (token_hash, label, capability, max_redemptions, expires_at, created_by_user_id)
       VALUES ($1, $2, 'captain', $3, $4, $5::uuid)
       RETURNING id::text AS id, label, max_redemptions, expires_at, created_at,
         created_by_user_id::text AS created_by_user_id, ${CREATED_BY_NAME} AS created_by_name,
         revoked_at, revoked_by_user_id::text AS revoked_by_user_id, '[]'::json AS redemptions`,
      [tokenHash, label, maxRedemptions, expiresAt.toISOString(), input.actorOperatorId],
    );
    const row = rows[0];
    await recordAuditEvent(tx, {
      kind: "captain.invitation_created",
      actor: { kind: "operator", id: input.actorOperatorId },
      metadata: { invitationId: String(row.id), maxRedemptions, label },
    });
    return toListing(row);
  });

  return { token, invitation };
}

/**
 * What a landing page needs to render "this link grants Captain access":
 * redeemability, never identity. No token, no creator, no redeemer list.
 * A pure read — it locks nothing and writes nothing. Null for an unknown
 * token, so a guessed or mistyped link is indistinguishable from a real one
 * that happens to be full or expired.
 */
export type CaptainInvitationRedeemability = {
  id: string;
  capability: "captain";
  label: string | null;
  expiresAt: string;
  expired: boolean;
  revoked: boolean;
  full: boolean;
};

export async function readCaptainInvitationByToken(db: BuilderQuery, token: string): Promise<CaptainInvitationRedeemability | null> {
  const { rows } = await db.query(
    `SELECT i.id::text AS id, i.label, i.max_redemptions, i.expires_at, i.revoked_at,
       (SELECT count(*) FROM hq_captain_invitation_redemptions r WHERE r.invitation_id = i.id) AS redemptions
     FROM hq_captain_invitations i WHERE i.token_hash = $1`,
    [hashToken(token)],
  );
  if (!rows.length) return null;
  const row = rows[0];
  const expiresAt = toIso(row.expires_at);
  return {
    id: String(row.id),
    capability: "captain",
    label: row.label == null ? null : String(row.label),
    expiresAt,
    expired: new Date(expiresAt).getTime() <= Date.now(),
    revoked: row.revoked_at != null,
    full: Number(row.redemptions) >= Number(row.max_redemptions),
  };
}

/**
 * "An authenticated, verified HQ account" — the one rule in
 * lib/hq/identity.ts#isVerifiedAccount, called here so acceptCaptainInvitation
 * enforces it itself rather than trusting whatever called it. Only a userId
 * is in hand here (not a session's already-loaded user row), so this reads
 * `hq_auth_user` itself; the object below is passed straight into
 * isVerifiedAccount's own parameter type without a separate helper or a
 * hand-copied type, so if StoredAccount ever gains a required field, this
 * call site fails to type-check instead of silently answering the old rule.
 *
 * Called *before* opening the redemption transaction below, not from inside
 * it: isVerifiedAccount reads hq_auth_telegram_identity through the default
 * builderDatabase() pool, not through the transaction's own client. Under the
 * PGlite test pool (tests/hq/helpers/db.ts#pgliteBuilderDatabase), calling
 * back into that same wrapped handle from *inside* one of its own
 * transactions deadlocks on its single-connection queue; calling it first,
 * before the transaction exists, does not.
 */
async function isVerifiedForRedemption(db: BuilderQuery, userId: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT email, "emailVerified" AS verified FROM hq_auth_user WHERE id = $1`, [userId]);
  if (!rows.length) return false;
  return isVerifiedAccount({ id: userId, email: rows[0].email == null ? null : String(rows[0].email), emailVerified: Boolean(rows[0].verified) });
}

export type AcceptCaptainInvitationResult =
  | { outcome: "granted" }
  /** A previous successful redemption by this same account under this same invitation. No new row, no new grant — even if the grant was since revoked. */
  | { outcome: "already-redeemed" }
  /** The account already holds an active Captain grant from elsewhere. No slot consumed. */
  | { outcome: "already-captain" }
  | { outcome: "revoked" }
  | { outcome: "expired" }
  | { outcome: "full" }
  | { outcome: "unverified" }
  | { outcome: "not-found" }
  /** Verified in hq_auth_user, but its hq_builder_profiles row (which the redemption's FK and grantCapability both require) has not been created yet — a genuine, if narrow, window rather than an account that can never redeem. */
  | { outcome: "no-profile" };

/**
 * The one redemption transaction the plan describes, and the only writer of
 * hq_captain_invitation_redemptions. Locks the invitation row, then decides
 * in this order:
 *
 *  1. The account must have an hq_builder_profiles row — the redemption
 *     insert's foreign key and grantCapability both require one — checked
 *     up front so a narrow pre-sync window fails as a typed outcome instead
 *     of an unhandled foreign-key error.
 *  2. An existing redemption row for (invitationId, userId) wins over
 *     everything else below, including a since-revoked invitation or a
 *     since-revoked grant — "a revoked grant cannot be resurrected by
 *     replaying an already consumed redemption; a new admin grant/invitation
 *     is required" means this function must never re-run the grant for a
 *     replay, no matter what state anything else is in.
 *  3. An account that already holds an active Captain grant, from anywhere,
 *     is not blocked by this invitation's revocation, expiry or capacity: it
 *     has nothing to receive from this link, so those checks do not apply to
 *     it either. (The reading: "an invitation use means one distinct HQ
 *     account successfully *receiving* Captain access" — an already-captain
 *     account cannot newly receive it, so redeeming for the first time is
 *     not a "use" and consumes no slot; see the task report for the full
 *     reasoning.)
 *  4. Only then do revoked / expired / full gate a genuinely new grant.
 *
 * grantCapability (the sole writer of hq_account_capabilities) is called with
 * a *member* actor — the account redeemed this itself — and byOperatorId set
 * to whoever created the invitation, or null if that operator's row is gone.
 */
export async function acceptCaptainInvitation(
  db: BuilderDatabase,
  input: { invitationId: string; userId: string },
): Promise<AcceptCaptainInvitationResult> {
  if (!(await isVerifiedForRedemption(db, input.userId))) return { outcome: "unverified" };

  return db.transaction(async (tx) => {
    const { rows: invitations } = await tx.query(
      `SELECT label, max_redemptions, expires_at, revoked_at, created_by_user_id::text AS created_by_user_id
       FROM hq_captain_invitations WHERE id = $1::uuid FOR UPDATE`,
      [input.invitationId],
    );
    if (!invitations.length) return { outcome: "not-found" };

    const { rows: profiles } = await tx.query(`SELECT 1 FROM hq_builder_profiles WHERE id = $1`, [input.userId]);
    if (!profiles.length) return { outcome: "no-profile" };

    const row = invitations[0];
    const invitation = {
      label: row.label == null ? null : String(row.label),
      maxRedemptions: Number(row.max_redemptions),
      expiresAt: new Date(String(row.expires_at)),
      revoked: row.revoked_at != null,
      createdByUserId: row.created_by_user_id == null ? null : String(row.created_by_user_id),
    };

    const { rows: existing } = await tx.query(
      `SELECT 1 FROM hq_captain_invitation_redemptions WHERE invitation_id = $1::uuid AND user_id = $2`,
      [input.invitationId, input.userId],
    );
    if (existing.length) return { outcome: "already-redeemed" };

    const active = await listActiveCapabilitiesForUsers([input.userId], tx);
    if (active.get(input.userId)?.includes("captain")) return { outcome: "already-captain" };

    if (invitation.revoked) return { outcome: "revoked" };
    if (invitation.expiresAt.getTime() <= Date.now()) return { outcome: "expired" };

    const { rows: countRows } = await tx.query(
      `SELECT count(*)::int AS n FROM hq_captain_invitation_redemptions WHERE invitation_id = $1::uuid`,
      [input.invitationId],
    );
    if (Number(countRows[0].n) >= invitation.maxRedemptions) return { outcome: "full" };

    // Never a NULL user_id here (see the module header): input.userId is
    // required and comes straight from the caller's own verified session id.
    await tx.query(`INSERT INTO hq_captain_invitation_redemptions (invitation_id, user_id) VALUES ($1::uuid, $2)`, [input.invitationId, input.userId]);
    await grantCapability(tx, {
      actor: { kind: "member", id: input.userId },
      byOperatorId: invitation.createdByUserId,
      userId: input.userId,
      capability: "captain",
      reason: invitation.label ? `Redeemed a Captain invitation ("${invitation.label}")` : "Redeemed a Captain invitation",
    });
    await recordAuditEvent(tx, {
      kind: "captain.invitation_redeemed",
      actor: { kind: "member", id: input.userId },
      subjectUserId: input.userId,
      metadata: { invitationId: input.invitationId },
    });
    return { outcome: "granted" };
  });
}

/**
 * Stops future redemption only — existing Captains keep their grants.
 * Idempotent: revoking an already-revoked (or unknown) invitation writes
 * nothing and returns null, same as revokeCapability's idempotence.
 */
export async function revokeCaptainInvitation(
  db: BuilderQuery | BuilderDatabase,
  input: { actorOperatorId: string; invitationId: string; reason?: string },
): Promise<CaptainInvitationListing | null> {
  return atomically(db, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE hq_captain_invitations SET revoked_at = now(), revoked_by_user_id = $2::uuid
       WHERE id = $1::uuid AND revoked_at IS NULL
       RETURNING id::text AS id, label, max_redemptions, expires_at, created_at,
         created_by_user_id::text AS created_by_user_id, ${CREATED_BY_NAME} AS created_by_name,
         revoked_at, revoked_by_user_id::text AS revoked_by_user_id, ${REDEMPTIONS_SUBQUERY("hq_captain_invitations.id")}`,
      [input.invitationId, input.actorOperatorId],
    );
    if (!rows.length) return null;
    const listing = toListing(rows[0]);
    await recordAuditEvent(tx, {
      kind: "captain.invitation_revoked",
      actor: { kind: "operator", id: input.actorOperatorId },
      metadata: { invitationId: input.invitationId, reason: input.reason ?? null },
    });
    return listing;
  });
}

/** The operator listing: label, capacity, used count, expiry, revocation state, creator and redeemers. Newest invitation first. */
export async function listCaptainInvitations(db: BuilderQuery = builderDatabase()): Promise<CaptainInvitationListing[]> {
  const { rows } = await db.query(`
    SELECT i.id::text AS id, i.label, i.max_redemptions, i.expires_at, i.created_at,
      i.created_by_user_id::text AS created_by_user_id, u.display_name AS created_by_name,
      i.revoked_at, i.revoked_by_user_id::text AS revoked_by_user_id,
      COALESCE(json_agg(json_build_object('userId', r.user_id, 'name', b.name, 'redeemedAt', r.redeemed_at) ORDER BY r.redeemed_at)
        FILTER (WHERE r.id IS NOT NULL), '[]') AS redemptions
    FROM hq_captain_invitations i
    LEFT JOIN hq_users u ON u.id = i.created_by_user_id
    LEFT JOIN hq_captain_invitation_redemptions r ON r.invitation_id = i.id
    LEFT JOIN hq_builder_profiles b ON b.id = r.user_id
    GROUP BY i.id, u.display_name
    ORDER BY i.created_at DESC
  `);
  return rows.map(toListing);
}
