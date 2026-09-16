import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { recordAuditEvent, type AuditActor } from "./audit";
import { loadTeamMembership } from "./authz-sql";
import { atomically, builderDatabase, type BuilderDatabase, type BuilderQuery } from "./builder-db";
import { BuilderError } from "./builder-types";
import { grantCapability, listActiveCapabilitiesForUsers, listCapabilityGrants } from "./capabilities";
import { isVerifiedAccount } from "./identity";
import { toCaptainLeaderboardView, type CaptainLeaderboardView } from "./view-models";

/**
 * The Captain service (contracts.md's "Captain service" row): invitations
 * (T4.2) above, assignment (T4.4) below, then the reads (T4.5) — the
 * leaderboard, the admin drilldown and a team's own Captain lookup — at the
 * end of the file.
 *
 * The invitation tables are both from T4.1 (scripts/hq/builder-schema.sql,
 * read the comment blocks above them before touching this file):
 * `hq_captain_invitations` and `hq_captain_invitation_redemptions`. A
 * redemption row's `user_id` is nullable at the schema level (ON DELETE SET
 * NULL, so a deleted account's seat is never replenished) but this module
 * must never itself *insert* one without a real user_id — a NULL one would
 * consume a seat, grant nobody, and (NULL never equalling NULL) be
 * repeatable past the UNIQUE constraint.
 *
 * The assignment table, `hq_captain_assignments` (also T4.1), is documented
 * where the assignment functions below use it.
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

    // Different invitations can target the same account concurrently. Share
    // the grant writer's account lock before checking access or using a slot.
    const { rows: profiles } = await tx.query(`SELECT 1 FROM hq_builder_profiles WHERE id = $1 FOR UPDATE`, [input.userId]);
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

/*
 * ---------------------------------------------------------------------------
 * Assignment (task T4.4)
 * ---------------------------------------------------------------------------
 *
 * `hq_captain_assignments` (T4.1, scripts/hq/builder-schema.sql — read the
 * comment block above its CREATE TABLE before touching this section) holds
 * one nullable current Captain per project plus its full history:
 * `unassigned_at IS NULL` marks a row current, ending an assignment sets that
 * column rather than deleting the row, `captain_user_id` is nullable with ON
 * DELETE SET NULL so a deleted account's history survives it, and both
 * partial indexes additionally require `captain_user_id IS NOT NULL` so an
 * orphaned row (a deleted account's former seat) is never read back as live
 * — `loadCurrentAssignment` in ./authz-sql already reads with that exact
 * predicate; every write below agrees with it.
 *
 * LOCK ORDER, applied consistently by every function below and by the two
 * membership-acceptance paths in ./builder-store.ts (`redeemInvite`,
 * `importTeam`) that must not race an assignment into existing alongside a
 * membership on the same project. A transaction that needs fewer of these
 * may skip the later ones, but nothing below ever acquires them out of
 * order, which is what makes the set deadlock free:
 *
 *   1. `hq_account_capabilities` — the candidate's active `captain` grant,
 *      a locking read. This is what fully serializes a concurrent
 *      `assignCaptain` against a concurrent revocation of that same
 *      account's grant (lib/hq/actions/capabilities.ts#revokeCaptainCapability
 *      -> ./capabilities#revokeCapability, which updates this same row):
 *      whichever transaction reaches the row first runs to completion before
 *      the other proceeds, so the loser always acts on the real, already
 *      committed outcome instead of a stale "still active" snapshot.
 *   2. `hq_projects` — a plain, unlocked read: the project must exist in the
 *      given edition. Nothing in this transaction, or in any transaction it
 *      might race, ever mutates a project's `hackathon_id`, so there is
 *      nothing to serialize against here and no lock is taken.
 *   3. `hq_project_onboarding`, locked *if* the project has a row there
 *      (`SELECT ... FOR UPDATE` on that table alone — Postgres refuses `FOR
 *      UPDATE` on the nullable side of an outer join, so this cannot be
 *      folded into one statement with step 2). This is the same row
 *      `redeemInvite` and `importTeam` already lock with their own `FOR
 *      UPDATE` before deciding whether to admit a member or a verified
 *      owner, and locking it here too is what closes the membership race the
 *      plan calls out: "assignment committing while a membership acceptance
 *      is in flight, and the reverse". Whichever transaction gets here first
 *      fully commits or rolls back before the other proceeds past this
 *      point, so the second transaction's own checks run over real,
 *      already-committed state rather than a pre-race snapshot. Neither side
 *      polls or retries; the lock itself is the wait. A project created
 *      directly in Admin (never imported) has no onboarding row, so this
 *      lock is a no-op for it — and correctly so, since nothing can ever
 *      race a membership acceptance onto a project that was never opened to
 *      one.
 *   3b. `hq_crm_persons`, the person rows this project's roster points at,
 *      locked in id order inside `checkCaptainConflict` (phase 3). It closes
 *      the race between that check's roster-identity source and
 *      `correctPersonMatch`, which became reachable the moment phase 3
 *      started stamping `person_id` onto imported roster rows. The full
 *      reasoning, and why locking was chosen over accepting the race, is at
 *      the statement itself.
 *   4. `hq_captain_assignments` — the project's current-assignment row, 0 or
 *      1 match. `unassignCaptain` and `clearCaptainAssignments` only ever
 *      need this table, so they skip 1 through 3 entirely; that is still
 *      safe under the same order, because neither of them ever goes on to
 *      need an earlier step afterward.
 *
 * A *never-before-assigned* project (no `hq_captain_assignments` row at all
 * yet) has nothing at step 4 for two concurrent `assignCaptain` calls to
 * lock against each other on — this lock order does not, by itself, force
 * them to serialize. What still makes "one project cannot hold two current
 * Captains" hold under that exact race is the partial unique index itself
 * (`hq_captain_assignments_one_current_idx`): the insert below is an
 * `ON CONFLICT ... DO NOTHING`, and the loser gets a typed `already_assigned`
 * conflict back instead of an unhandled constraint violation. This is
 * deliberately a database-level, not an application-level, guarantee for
 * that one case, since nothing upstream of the index can be locked to
 * prevent it.
 *
 * THE CONFLICT CHECK, `checkCaptainConflict` below, is deliberately not a
 * display-name comparison anywhere (the plan is explicit, and Phase 1's CRM
 * person identity exists precisely so it never has to be). Two independent
 * sources, checked in this order:
 *
 *   1. Verified HQ team membership — `loadTeamMembership` (./authz-sql),
 *      reused rather than re-implemented: the project's verified owner, or a
 *      joined roster row.
 *   2. Linked imported roster identity — every `hq_project_members` row of
 *      an *imported* project (one with an `hq_project_onboarding` row; a
 *      hand-added Admin project has no imported roster to check, so this
 *      source is simply inapplicable to it and the check ends at source 1),
 *      resolved either directly (`builder_user_id`, which also catches a
 *      project's owner before its claim is verified — source 1 requires
 *      `verification = 'verified'` and so misses that window on its own) or
 *      through its linked CRM person (`person_id` -> `hq_crm_persons
 *      .builder_user_id`).
 *
 * A roster row that source 2 cannot resolve either way — no `person_id` at
 * all (today's common case: Phase 3 has not run, so nothing calls
 * `ensurePersonForRosterMember` yet and every imported roster row starts with
 * `person_id NULL`), or a `person_id` whose person has never been linked to
 * an account — is **not** silently passed. It is collected as "needs
 * review" and the assignment stops *unless* the caller explicitly
 * acknowledges it: `acknowledgedUnresolvedIds` must name the *exact* set of
 * `hq_project_members.id`s the caller was shown as unresolved. This
 * transaction re-derives the unresolved set itself rather than trusting
 * whatever an earlier read returned, and if the two sets differ — a roster
 * row resolved, or a new one appeared, since the operator last looked —
 * the acknowledgement does not count: `needs_review` comes back again, with
 * the current set, rather than assigning over rows the caller never
 * actually saw. On a match, the acknowledged ids are recorded on the
 * `captain.assigned` audit event's metadata (not just a count), so the
 * override itself leaves a trail of exactly what was overridden. This is
 * the "warning the operator must acknowledge" reading of the plan's
 * "surface it for admin review rather than claiming the conflict check is
 * complete": it blocks by default (nothing is assigned on the first call),
 * and only proceeds on a second, explicit call that names the precise risk
 * it is accepting. See the task report for why a hard, un-overridable block
 * was rejected: today it would make Captain assignment practically
 * unusable, since nearly every imported roster has an unclaimed member with
 * no resolvable identity.
 */

/** One row of an "imported roster identity" conflict, or of a "needs review" list — never a display-name match, always this project's own `hq_project_members` row. */
export type UnresolvedRosterMember = { memberId: string; name: string; username: string | null };

export type CaptainConflictReason =
  | { kind: "verified_member"; role: "owner" | "member" }
  | { kind: "roster_member"; memberName: string; memberUsername: string | null }
  /**
   * The account named `owner_user_id` on the project's own
   * `hq_project_onboarding` row — the account that submitted the Colosseum
   * claim — regardless of `verification` state and regardless of whether it
   * also has a linked roster row (`importTeam` only links one when a roster
   * member's username matches the claimant's exactly; a claimant absent
   * from the roster, or case-mismatched against it, gets none). Strictly
   * wider than `verified_member`'s owner case, not a duplicate of it: this
   * is what closes the pending/rejected window `loadTeamMembership` cannot
   * see on its own, so a claimant can never become their own project's
   * Captain through an unverified claim plus an acknowledged "needs review".
   */
  | { kind: "claimant" }
  /**
   * The one case the lock order above cannot itself serialize: two
   * concurrent `assignCaptain` calls on the same *never-before-assigned*
   * project have no `hq_captain_assignments` row yet to lock against each
   * other on (lock order step 4 is a no-op for both). Step 2 (`hq_projects`)
   * is a deliberately *unlocked* read — see the header block above — so it
   * cannot close this either. What actually guarantees "one project cannot
   * hold two current Captains" here is the database: the insert is
   * `ON CONFLICT ... DO NOTHING` against the partial unique index, and the
   * loser gets this typed outcome back instead of an unhandled constraint
   * violation. This is load-bearing, not a defensive fallback — do not
   * remove the `ON CONFLICT` clause on the theory that some lock already
   * covers this case; none does.
   */
  | { kind: "already_assigned" };

export type AssignCaptainResult =
  | { outcome: "assigned"; assignmentId: string; replacedCaptainUserId: string | null }
  /** Missing, or real but in a different edition than `hackathonId` — answered identically, so neither reveals the other. */
  | { outcome: "not_found" }
  | { outcome: "no_grant" }
  | { outcome: "conflict"; conflict: CaptainConflictReason }
  | { outcome: "needs_review"; unresolved: UnresolvedRosterMember[] };

type ConflictCheck =
  | { kind: "clear" }
  | { kind: "conflict"; conflict: CaptainConflictReason }
  | { kind: "needs_review"; unresolved: UnresolvedRosterMember[] };

/** The conflict check described above. `onboarded` decides whether source 2 (the imported roster) applies at all; `ownerUserId` is the onboarding row's own claimant, independent of the roster. */
async function checkCaptainConflict(
  tx: BuilderQuery,
  input: { candidateUserId: string; projectId: string; onboarded: boolean; ownerUserId: string | null },
): Promise<ConflictCheck> {
  const membership = await loadTeamMembership(tx, { userId: input.candidateUserId, projectId: input.projectId });
  if (membership) return { kind: "conflict", conflict: { kind: "verified_member", role: membership.role } };
  if (!input.onboarded) return { kind: "clear" };
  if (input.ownerUserId != null && input.ownerUserId === input.candidateUserId) return { kind: "conflict", conflict: { kind: "claimant" } };

  // Lock order step 3b (phase 3's decision; see the lock-order block above).
  //
  // Until phase 3 wired `ensurePersonForRosterMember` into the import path,
  // every roster row's `person_id` was NULL and this scan's CRM branch was
  // unreachable. Now that roster rows carry real persons, this check shares
  // state with `correctPersonMatch` (./crm-identity.ts, an operator action)
  // with nothing serialising the pair: an admin re-pointing a person onto an
  // account at the same moment another admin assigns that account as Captain
  // of a project that person's roster row belongs to could otherwise commit
  // exactly the state T4.4 closed for its other two sources — a participant
  // captaining their own team.
  //
  // The decision taken in phase 3 is to LOCK rather than accept the race.
  // Both operations are rare and operator-triggered, but the state they can
  // land in is a product invariant the plan states unconditionally ("A
  // Captain cannot be assigned to a team they participate in"), and the lock
  // costs one extra statement on a path that already holds three locks.
  //
  // The lock is taken on the CRM person rows, in id order, in a statement of
  // their own rather than as `FOR UPDATE` on this outer join (Postgres
  // refuses `FOR UPDATE` on the nullable side of an outer join). Ordering by
  // id keeps two concurrent assignments on overlapping rosters deadlock free
  // between themselves, and `correctPersonMatch` only ever locks one person
  // row and never reaches for the capability, project or assignment locks
  // this transaction already holds, so there is no cycle between the two.
  const { rows: personIds } = await tx.query(
    `SELECT DISTINCT person_id FROM hq_project_members
     WHERE project_id = $1::uuid AND person_id IS NOT NULL ORDER BY person_id`,
    [input.projectId],
  );
  if (personIds.length) {
    await tx.query(
      "SELECT id FROM hq_crm_persons WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
      [personIds.map((row) => String(row.person_id))],
    );
  }

  const { rows } = await tx.query(
    `SELECT m.id::text AS id, m.name, m.colosseum_username, m.builder_user_id,
            m.person_id::text AS person_id, p.builder_user_id::text AS person_account_id
     FROM hq_project_members m LEFT JOIN hq_crm_persons p ON p.id = m.person_id
     WHERE m.project_id = $1::uuid`,
    [input.projectId],
  );
  const unresolved: UnresolvedRosterMember[] = [];
  for (const row of rows) {
    const username = row.colosseum_username == null ? null : String(row.colosseum_username);
    const direct = row.builder_user_id == null ? null : String(row.builder_user_id);
    if (direct != null) {
      // A joined-or-owning account is fully resolved either way: the
      // candidate's own account (a conflict, including the pre-verification
      // owner window source 1 misses) or, definitively, someone else's.
      if (direct === input.candidateUserId) return { kind: "conflict", conflict: { kind: "roster_member", memberName: String(row.name), memberUsername: username } };
      continue;
    }
    if (row.person_id != null) {
      const viaPerson = row.person_account_id == null ? null : String(row.person_account_id);
      if (viaPerson != null) {
        if (viaPerson === input.candidateUserId) return { kind: "conflict", conflict: { kind: "roster_member", memberName: String(row.name), memberUsername: username } };
        continue; // Linked to a different account: resolved, not the candidate.
      }
      // A provisional person (matched by Colosseum username) with no linked
      // account yet: cannot be cleared or condemned. Falls through to unresolved.
    }
    unresolved.push({ memberId: String(row.id), name: String(row.name), username });
  }
  return unresolved.length ? { kind: "needs_review", unresolved } : { kind: "clear" };
}

/**
 * Whether `acknowledgedIds` names exactly the current unresolved set — no
 * fewer, no more, no stale or substituted ids. Order-independent;
 * `undefined` (no acknowledgement offered at all) never matches. The set
 * sizes are compared, not just the array lengths: a duplicate id inflates
 * `acknowledgedIds.length` to match `unresolved.length` while naming fewer
 * distinct rows than it actually shows, which a plain length check would
 * accept.
 */
function acknowledgesExactly(unresolved: UnresolvedRosterMember[], acknowledgedIds: string[] | undefined): boolean {
  if (!acknowledgedIds) return false;
  const current = new Set(unresolved.map((member) => member.memberId));
  const acknowledged = new Set(acknowledgedIds);
  return acknowledged.size === current.size && acknowledgedIds.every((id) => current.has(id));
}

/**
 * Assigns (or reassigns) the current Captain of a project, in one
 * transaction under the lock order documented above. Choosing to insert the
 * same account already current is a no-op (no history churn, no audit
 * event): `acknowledgedUnresolvedIds` only matters on a real change.
 *
 * `acknowledgedUnresolvedIds`, when given, must name the exact
 * `hq_project_members.id`s the caller was shown as unresolved — checked
 * against this transaction's own, freshly re-derived unresolved set, not
 * whatever an earlier read returned. A mismatch (something resolved, or
 * something new appeared) is treated as no acknowledgement at all: the
 * caller gets `needs_review` again, with the current set, rather than the
 * assignment going through over rows it never actually saw.
 *
 * Replacing a different current Captain ends every other currently live row
 * for the project (`unassigned_at`, `unassigned_by_user_id`) — at most one
 * under the partial unique index, but ended as a set rather than assumed to
 * be exactly one row — and audits `captain.unassigned` for whichever of
 * them actually named a captain, before the new `captain.assigned`, so the
 * partial unique index is never violated and a reassignment is one atomic
 * operation, not two. An orphaned row (`captain_user_id IS NULL`, the
 * account was deleted) is ended the same way but audits nothing for it:
 * `loadCurrentAssignment` never treated it as a live assignment, so nothing
 * is being "unassigned" from that account's perspective, but it still must
 * not be left sitting there — schema comment on `hq_captain_assignments`.
 */
export async function assignCaptain(
  db: BuilderQuery | BuilderDatabase,
  input: {
    actorOperatorId: string; projectId: string; hackathonId: number; captainUserId: string; reason?: string;
    acknowledgedUnresolvedIds?: string[];
  },
): Promise<AssignCaptainResult> {
  return atomically(db, async (tx) => {
    // Lock order step 1.
    const { rows: grants } = await tx.query(
      `SELECT 1 FROM hq_account_capabilities WHERE user_id = $1 AND capability = 'captain' AND revoked_at IS NULL FOR UPDATE`,
      [input.captainUserId],
    );
    if (!grants.length) return { outcome: "no_grant" };

    // Lock order step 2: the project must exist in the given edition.
    const { rows: projects } = await tx.query(`SELECT hackathon_id FROM hq_projects WHERE id = $1::uuid`, [input.projectId]);
    if (!projects.length || Number(projects[0].hackathon_id) !== input.hackathonId) return { outcome: "not_found" };

    // Lock order step 3: the project's onboarding row, if it has one.
    const { rows: onboarding } = await tx.query(`SELECT owner_user_id FROM hq_project_onboarding WHERE project_id = $1::uuid FOR UPDATE`, [input.projectId]);
    const onboarded = onboarding.length > 0;
    const ownerUserId = onboarding[0]?.owner_user_id == null ? null : String(onboarding[0].owner_user_id);

    const conflict = await checkCaptainConflict(tx, { candidateUserId: input.captainUserId, projectId: input.projectId, onboarded, ownerUserId });
    if (conflict.kind === "conflict") return { outcome: "conflict", conflict: conflict.conflict };
    if (conflict.kind === "needs_review" && !acknowledgesExactly(conflict.unresolved, input.acknowledgedUnresolvedIds)) {
      return { outcome: "needs_review", unresolved: conflict.unresolved };
    }

    // Lock order step 4. No LIMIT: this selects and locks *every* currently
    // live row for the project, not just one. Under the partial unique
    // index there should never be more than one, but the ending step right
    // below acts on the whole set it finds rather than assuming that —
    // a set-based end that survives that invariant ever breaking, instead
    // of a by-id end of an arbitrarily chosen first row that would leave
    // any others (an orphaned row alongside a live one; a hypothetical
    // future bug) still marked current. That guarantee holds on the
    // reassignment path below, through the `toEnd` loop. The no-op path
    // right here (the candidate is already the current Captain) returns
    // before that loop runs, so it does NOT end a stray extra live row: if
    // the invariant were already broken (an orphaned row alongside the
    // live one this candidate holds, say), re-assigning the same candidate
    // leaves that stray row exactly as it was. Only a real change — a
    // different candidate, which always reaches `toEnd` — cleans up strays.
    const { rows: current } = await tx.query(
      `SELECT id::text AS id, captain_user_id::text AS captain_user_id FROM hq_captain_assignments
       WHERE project_id = $1::uuid AND unassigned_at IS NULL FOR UPDATE`,
      [input.projectId],
    );
    const currentRows = current as Array<{ id: string; captain_user_id: string | null }>;
    const alreadyCurrent = currentRows.find((row) => row.captain_user_id === input.captainUserId);
    if (alreadyCurrent) {
      return { outcome: "assigned", assignmentId: alreadyCurrent.id, replacedCaptainUserId: null };
    }
    const toEnd = currentRows.filter((row) => row.captain_user_id !== input.captainUserId);
    for (const row of toEnd) {
      await tx.query(`UPDATE hq_captain_assignments SET unassigned_at = now(), unassigned_by_user_id = $2::uuid WHERE id = $1::uuid`, [row.id, input.actorOperatorId]);
    }
    // The one live row with a real captain among whatever was ended — under
    // the invariant holding, `toEnd` has at most one entry at all.
    const replaced = toEnd.find((row) => row.captain_user_id != null) ?? null;

    const { rows: inserted } = await tx.query(
      `INSERT INTO hq_captain_assignments (project_id, captain_user_id, assigned_by_user_id, reason)
       VALUES ($1::uuid, $2, $3::uuid, $4)
       ON CONFLICT (project_id) WHERE unassigned_at IS NULL AND captain_user_id IS NOT NULL DO NOTHING
       RETURNING id::text AS id`,
      [input.projectId, input.captainUserId, input.actorOperatorId, input.reason ?? null],
    );
    if (!inserted.length) return { outcome: "conflict", conflict: { kind: "already_assigned" } };

    if (replaced) {
      await recordAuditEvent(tx, {
        kind: "captain.unassigned",
        actor: { kind: "operator", id: input.actorOperatorId },
        subjectUserId: replaced.captain_user_id!,
        hackathonId: input.hackathonId,
        projectId: input.projectId,
        metadata: { assignmentId: replaced.id, reassignedToUserId: input.captainUserId },
      });
    }
    await recordAuditEvent(tx, {
      kind: "captain.assigned",
      actor: { kind: "operator", id: input.actorOperatorId },
      subjectUserId: input.captainUserId,
      hackathonId: input.hackathonId,
      projectId: input.projectId,
      metadata: {
        assignmentId: inserted[0].id,
        reason: input.reason ?? null,
        replacedCaptainUserId: replaced?.captain_user_id ?? null,
        // The exact rows overridden, not just how many — this is the one
        // place a safety check is deliberately bypassed, and the audit
        // trail is its only record of what, specifically, was overridden.
        acknowledgedUnresolvedMemberIds: conflict.kind === "needs_review" ? conflict.unresolved.map((member) => member.memberId) : [],
      },
    });
    return { outcome: "assigned", assignmentId: String(inserted[0].id), replacedCaptainUserId: replaced?.captain_user_id ?? null };
  });
}

export type UnassignCaptainResult =
  | { outcome: "unassigned"; assignmentId: string; captainUserId: string }
  /**
   * Also covers a write that did happen: an orphaned row
   * (`captain_user_id IS NULL`, the account was deleted) with no live
   * captain is still ended here — see the function body — but is reported
   * identically to "nothing to remove", because `loadCurrentAssignment`
   * never treated it as a live assignment in the first place, so nothing
   * observable changed from any caller's point of view.
   * `unassignProjectCaptain` (lib/hq/actions/captains.ts) relies on exactly
   * this to skip `refreshHq()` for it.
   */
  | { outcome: "not_assigned" }
  | { outcome: "not_found" };

/**
 * Ends the project's current assignment, idempotent and audited. Only ever
 * needs lock order step 4 (see above): removing a Captain can never create
 * the membership conflict step 2's onboarding lock exists to prevent, so
 * there is nothing else to serialize against here.
 */
export async function unassignCaptain(
  db: BuilderQuery | BuilderDatabase,
  input: { actorOperatorId: string; projectId: string; hackathonId: number; reason?: string },
): Promise<UnassignCaptainResult> {
  return atomically(db, async (tx) => {
    const { rows: projects } = await tx.query(`SELECT hackathon_id FROM hq_projects WHERE id = $1::uuid`, [input.projectId]);
    if (!projects.length || Number(projects[0].hackathon_id) !== input.hackathonId) return { outcome: "not_found" };

    const { rows } = await tx.query(
      `UPDATE hq_captain_assignments SET unassigned_at = now(), unassigned_by_user_id = $2::uuid
       WHERE project_id = $1::uuid AND unassigned_at IS NULL
       RETURNING id::text AS id, captain_user_id::text AS captain_user_id`,
      [input.projectId, input.actorOperatorId],
    );
    const captainUserId = rows[0]?.captain_user_id == null ? null : String(rows[0].captain_user_id);
    // The UPDATE above already committed to ending rows[0] if it matched at
    // all — including an orphaned one (captain_user_id IS NULL) — so a
    // "not_assigned" answer here can still mean a row was just cleaned up.
    // See UnassignCaptainResult's own doc comment for why that is reported
    // this way rather than as a distinct outcome.
    if (!rows.length || !captainUserId) return { outcome: "not_assigned" };

    await recordAuditEvent(tx, {
      kind: "captain.unassigned",
      actor: { kind: "operator", id: input.actorOperatorId },
      subjectUserId: captainUserId,
      hackathonId: input.hackathonId,
      projectId: input.projectId,
      metadata: { assignmentId: rows[0].id, reason: input.reason ?? null },
    });
    return { outcome: "unassigned", assignmentId: String(rows[0].id), captainUserId };
  });
}

export type ClearedCaptainAssignment = { assignmentId: string; projectId: string; projectName: string; hackathonId: number };

/**
 * Ends every current assignment an account holds, across every edition (a
 * Captain grant is account-global, so revoking it must clear all of them,
 * not just the selected edition's), auditing each `captain.unassigned`
 * individually. Called from lib/hq/actions/capabilities.ts#revokeCaptainCapability
 * inside the *same* transaction as the grant's own revocation — pass it the
 * transaction client so `atomically` joins that transaction instead of
 * opening a second one, which is what makes the grant and the clear commit
 * or roll back together.
 *
 * Phase 7 (not yet built; the bot does not exist and
 * `hq_telegram_bot_consent` holds no drafts yet — the plan's "invalidate
 * pending bot actions") must invalidate any pending bot action addressed to
 * this `captainUserId` for one of the projects returned here, in this same
 * transaction, so a revoked Captain's stale draft can never be delivered or
 * actioned after this commits.
 */
export async function clearCaptainAssignments(
  db: BuilderQuery | BuilderDatabase,
  input: { actor: AuditActor; byOperatorId: string | null; captainUserId: string; reason?: string },
): Promise<ClearedCaptainAssignment[]> {
  return atomically(db, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE hq_captain_assignments a SET unassigned_at = now(), unassigned_by_user_id = $2::uuid
       FROM hq_projects p
       WHERE a.captain_user_id = $1 AND a.unassigned_at IS NULL AND a.project_id = p.id
       RETURNING a.id::text AS id, a.project_id::text AS project_id, p.name AS project_name, p.hackathon_id`,
      [input.captainUserId, input.byOperatorId],
    );
    for (const row of rows) {
      await recordAuditEvent(tx, {
        kind: "captain.unassigned",
        actor: input.actor,
        subjectUserId: input.captainUserId,
        hackathonId: Number(row.hackathon_id),
        projectId: String(row.project_id),
        metadata: { assignmentId: row.id, reason: input.reason ?? null, cause: "captain_capability_revoked" },
      });
    }
    return rows.map((row) => ({ assignmentId: String(row.id), projectId: String(row.project_id), projectName: String(row.project_name), hackathonId: Number(row.hackathon_id) }));
  });
}

export type CaptainAssignmentSummary = { projectId: string; projectName: string; hackathonId: number };

/**
 * The current assignments one account holds, across every edition — what
 * revoking its Captain grant would clear. A pre-flight read for the Admin
 * confirmation copy ("Confirm the affected project count to the admin"):
 * `clearCaptainAssignments` re-derives this itself inside its own
 * transaction rather than trusting whatever this returned a moment earlier.
 */
export async function countAssignmentsForCaptain(db: BuilderQuery, userId: string): Promise<CaptainAssignmentSummary[]> {
  const { rows } = await db.query(
    `SELECT a.project_id::text AS project_id, p.name AS project_name, p.hackathon_id
     FROM hq_captain_assignments a JOIN hq_projects p ON p.id = a.project_id
     WHERE a.captain_user_id = $1 AND a.unassigned_at IS NULL
     ORDER BY p.name`,
    [userId],
  );
  return rows.map((row) => ({ projectId: String(row.project_id), projectName: String(row.project_name), hackathonId: Number(row.hackathon_id) }));
}

/** The same count as `countAssignmentsForCaptain`, batched for many accounts in one indexed query — the People/Admin account list's read, mirroring `listActiveCapabilitiesForUsers`'s shape. Every requested id is present, 0 for none. */
export async function countAssignmentsForUsers(db: BuilderQuery, userIds: readonly string[]): Promise<Map<string, number>> {
  const ids = [...new Set(userIds)];
  const result = new Map<string, number>(ids.map((id) => [id, 0]));
  if (!ids.length) return result;
  const { rows } = await db.query(
    `SELECT captain_user_id AS user_id, count(*)::int AS n FROM hq_captain_assignments
     WHERE unassigned_at IS NULL AND captain_user_id IS NOT NULL AND captain_user_id = ANY($1::text[])
     GROUP BY captain_user_id`,
    [ids],
  );
  for (const row of rows) result.set(String(row.user_id), Number(row.n));
  return result;
}

export type CurrentCaptainAssignment = {
  projectId: string; projectName: string; hackathonId: number; captainUserId: string; captainName: string; assignedAt: string;
};

/**
 * The operator drilldown, always scoped to one edition (a Captain's projects
 * span editions, but this reads only the one the admin is looking at — T4.5
 * uses this for the leaderboard drilldown, itself edition-scoped): every
 * project's current Captain in the edition, or — with `captainUserId` — just
 * that Captain's current projects there.
 */
export async function listAssignments(db: BuilderQuery, input: { hackathonId: number; captainUserId?: string }): Promise<CurrentCaptainAssignment[]> {
  const values: unknown[] = [input.hackathonId];
  let filter = "";
  if (input.captainUserId) {
    values.push(input.captainUserId);
    filter = ` AND a.captain_user_id = $${values.length}`;
  }
  const { rows } = await db.query(
    `SELECT a.project_id::text AS project_id, p.name AS project_name, p.hackathon_id,
            a.captain_user_id AS captain_user_id, b.name AS captain_name, a.assigned_at
     FROM hq_captain_assignments a
     JOIN hq_projects p ON p.id = a.project_id
     JOIN hq_builder_profiles b ON b.id = a.captain_user_id
     WHERE p.hackathon_id = $1 AND a.unassigned_at IS NULL AND a.captain_user_id IS NOT NULL${filter}
     ORDER BY p.name`,
    values,
  );
  return rows.map((row) => ({
    projectId: String(row.project_id),
    projectName: String(row.project_name),
    hackathonId: Number(row.hackathon_id),
    captainUserId: String(row.captain_user_id),
    captainName: String(row.captain_name),
    assignedAt: toIso(row.assigned_at),
  }));
}

export type CaptainAssignmentCount = { captainUserId: string; captainName: string; assignedCount: number };

/**
 * The leaderboard's own read: one Captain per row with how many *active*
 * projects they currently captain in the edition, highest first — a
 * `GROUP BY` query, not `listAssignments`'s per-project rows grouped in JS
 * (the "load every project and count in the client" shape the plan
 * forbids).
 *
 * "Active HQ projects" (plan section 3) reads as
 * `hq_project_statuses.counts_as_active`, the same health flag
 * `getEventsWithOutputs`/`attributeOutputs` already use to separate a
 * project's "active" count from its raw "qualified" one: a project marked
 * red (not counting as active) drops out of the count here, though it still
 * appears in `listAssignments`'s admin drilldown, which shows the operator
 * everything regardless of status. Archived editions are already excluded
 * by the caller choosing a live `hackathonId`, and there are no discovery
 * records yet for this to filter out (a later phase's concern). The join
 * costs nothing extra: `hq_project_statuses` has a handful of rows, and the
 * row set driving it is already the small one
 * `hq_captain_assignments_captain_current_idx` selects.
 *
 * `leaderboard()` below maps this into
 * `lib/hq/view-models.ts#CaptainLeaderboardView`.
 */
export async function countAssignmentsByCaptain(db: BuilderQuery, hackathonId: number): Promise<CaptainAssignmentCount[]> {
  const { rows } = await db.query(
    `SELECT a.captain_user_id AS captain_user_id, b.name AS captain_name, count(*)::int AS n
     FROM hq_captain_assignments a
     JOIN hq_projects p ON p.id = a.project_id
     JOIN hq_project_statuses s ON s.id = p.status_id
     JOIN hq_builder_profiles b ON b.id = a.captain_user_id
     WHERE p.hackathon_id = $1 AND a.unassigned_at IS NULL AND a.captain_user_id IS NOT NULL AND s.counts_as_active
     GROUP BY a.captain_user_id, b.name
     ORDER BY n DESC, b.name`,
    [hackathonId],
  );
  return rows.map((row) => ({ captainUserId: String(row.captain_user_id), captainName: String(row.captain_name), assignedCount: Number(row.n) }));
}

export type ProjectCaptain = { captainUserId: string; captainName: string };

/**
 * The project's current Captain by display name, or null while none is
 * assigned. For a team's own view of who captains them
 * (`TeamCaptainView`, via `lib/hq/member-teams.ts#memberTeamView`): the
 * privacy contract lets a team read its own Captain, so this is safe for
 * any caller that has already authorized the viewer on this project — it
 * adds nothing about any *other* project or Captain. Unlike
 * `loadCurrentAssignment` (authz-sql.ts), which only needs the id for a
 * decision, this also carries the name a team page renders.
 */
export async function currentCaptainOfProject(db: BuilderQuery, projectId: string): Promise<ProjectCaptain | null> {
  const { rows } = await db.query(
    `SELECT a.captain_user_id AS captain_user_id, b.name AS captain_name
     FROM hq_captain_assignments a JOIN hq_builder_profiles b ON b.id = a.captain_user_id
     WHERE a.project_id = $1::uuid AND a.unassigned_at IS NULL AND a.captain_user_id IS NOT NULL`,
    [projectId],
  );
  return rows.length ? { captainUserId: String(rows[0].captain_user_id), captainName: String(rows[0].captain_name) } : null;
}

/**
 * The leaderboard: rank, display name and current assigned-team count for
 * every account that currently holds an active Captain grant, in the given
 * edition — visible to admins and Captains alike (plan section 2), so this
 * one function is shared by both, each gated at its own call site (the
 * Captain's `/hq/captain` page after `requireMemberActor` confirms the
 * `captain` capability; Admin's data loader after its own `requireUser()`).
 * `leaderboard` itself takes no actor and decides nothing: like
 * `listCapabilityGrants` and `listAuditEvents`, it would otherwise have to
 * import `./actor`, which `lib/hq/actions/captains.ts` (an operator action
 * module) reaches transitively through this file —
 * `tests/hq/operator-imports.test.ts` holds that boundary.
 *
 * Combines two reads in application code, not one SQL query: the indexed
 * assignment aggregate (`countAssignmentsByCaptain`) and the active-grant
 * list (`listCapabilityGrants`, `capabilities.ts`'s operator-only reader,
 * called here with `activeOnly: true` and narrowed to `userId`/`userName`
 * immediately — `reason`, `grantedByUserId` and `revokedByUserId` never
 * leave this function). The grant list is what makes a zero-assignment
 * Captain appear at all: `countAssignmentsByCaptain` only returns Captains
 * who currently hold at least one active-status project, so an eligible
 * Captain with none would otherwise be invisible. Driving the merge from
 * the grant list also means a count row for an id the grant list does not
 * name — a revoked Captain, if a stray live assignment ever outlived its
 * revocation — is silently dropped rather than carried into the result.
 *
 * Sorted by count descending, then display name ascending for a stable tie
 * order; zero-assignment Captains fall out of that same order into last
 * place, which is why there is no second "zero last" rule. `viewerUserId`
 * only marks the caller's own row (`CaptainLeaderboardView.isYou`); it is
 * compared and never returned. Pass null from a surface with no single
 * viewer, such as Admin's.
 */
export async function leaderboard(db: BuilderQuery, hackathonId: number, viewerUserId: string | null = null): Promise<CaptainLeaderboardView[]> {
  const [counts, grants] = await Promise.all([
    countAssignmentsByCaptain(db, hackathonId),
    listCapabilityGrants({ capability: "captain", activeOnly: true }, db),
  ]);
  const countByUser = new Map(counts.map((row) => [row.captainUserId, row.assignedCount]));
  const rows = grants
    .map((grant) => ({ captainUserId: grant.userId, displayName: grant.userName, assignedCount: countByUser.get(grant.userId) ?? 0 }))
    .sort((a, b) => b.assignedCount - a.assignedCount || a.displayName.localeCompare(b.displayName));
  return rows.map((row, index) => toCaptainLeaderboardView(row, index + 1, viewerUserId));
}
