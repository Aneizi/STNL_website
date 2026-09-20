import "server-only";
import { createHash,randomInt } from "node:crypto";
import { recordAuditEvent,type AuditActor } from "./audit";
import { loadTeamMembership } from "./authz-sql";
import { atomically,builderDatabase,type BuilderDatabase,type BuilderQuery } from "./builder-db";
import { BuilderError } from "./builder-types";
import { grantCapability,listActiveCapabilitiesForUsers } from "./capabilities";
import { isVerifiedAccount } from "./identity";

/**
 * Invitation redemption must always name a real account. Nullable redemption
 * user IDs preserve consumed seats after account deletion; inserting NULL
 * would bypass uniqueness and consume seats without granting access.
 */

/** Far beyond any realistic Captain cohort for one edition; finite so a typo (an extra zero) fails loudly instead of becoming unlimited. */
const MAX_REDEMPTIONS = 500;
/** Far beyond one edition's timeline; the same reasoning as MAX_REDEMPTIONS applies at least as strongly to a bearer token's lifetime — an uncapped "valid for" turns a typo into an effectively permanent Captain link. */
const MAX_VALIDITY_DAYS = 365;
const MAX_LABEL_LENGTH = 200;

/** Six easy-to-read characters, sampled uniformly from 32 letters and digits. */
const INVITE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newInvitationCode = () => Array.from({ length: 6 }, () => INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)]).join("");

/** New short codes ignore case; previously issued long tokens stay case-sensitive. */
const hashToken = (token: string) => {
  const value = token.trim();
  const normalized = /^[A-HJ-NP-Z2-9]{6}$/i.test(value) ? value.toUpperCase() : value;
  return createHash("sha256").update(normalized).digest("hex");
};

const toIso = (value: unknown) => (value instanceof Date ? value : new Date(String(value))).toISOString();

type CaptainInvitationRedeemer = {
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

type CaptainInvitationCreation = { token: string; invitation: CaptainInvitationListing };

/** Return the bearer code once; store only its digest. Creation and its token-free audit commit together. */
export async function createCaptainInvitation(
  db: BuilderQuery | BuilderDatabase,
  input: { actorOperatorId: string; label?: string | null; maxRedemptions: number; expiresInDays?: number; expiresAt?: string },
): Promise<CaptainInvitationCreation> {
  const maxRedemptions = validateMaxRedemptions(input.maxRedemptions);
  const expiresAt = resolveExpiry(input);
  const label = input.label?.trim() || null;
  if (label && label.length > MAX_LABEL_LENGTH) throw new BuilderError(`Label must be ${MAX_LABEL_LENGTH} characters or fewer.`);

  return atomically(db, async (tx) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const token = newInvitationCode();
      const { rows } = await tx.query(
        `INSERT INTO hq_captain_invitations (token_hash, label, capability, max_redemptions, expires_at, created_by_user_id)
         VALUES ($1, $2, 'captain', $3, $4, $5::uuid)
         ON CONFLICT (token_hash) DO NOTHING
         RETURNING id::text AS id, label, max_redemptions, expires_at, created_at,
           created_by_user_id::text AS created_by_user_id, ${CREATED_BY_NAME} AS created_by_name,
           revoked_at, revoked_by_user_id::text AS revoked_by_user_id, '[]'::json AS redemptions`,
        [hashToken(token), label, maxRedemptions, expiresAt.toISOString(), input.actorOperatorId],
      );
      const row = rows[0];
      if (!row) continue;
      await recordAuditEvent(tx, {
        kind: "captain.invitation_created",
        actor: { kind: "operator", id: input.actorOperatorId },
        metadata: { invitationId: String(row.id), maxRedemptions, label },
      });
      return { token, invitation: toListing(row) };
    }
    throw new BuilderError("Could not create an invitation code. Try again.");
  });
}

/** Public landing data contains redeemability only, with no creator or redeemer identity. */
type CaptainInvitationRedeemability = {
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
 * Verify before redemption: isVerifiedAccount uses the default pool, which
 * would deadlock if re-entered inside a single-connection test transaction.
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
 * Lock the invitation before checking capacity. A replay never restores a
 * revoked grant, and an existing Captain consumes no seat. A new redemption
 * and its member-attributed grant commit together.
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
 * Assignment lock order: active capability -> onboarding row (if present) ->
 * linked CRM people in ID order -> current assignment. Project edition reads
 * are unlocked. Import/join and CRM correction must respect the same order.
 * Revocation locks the capability first; removal alone only needs assignments.
 *
 * A first assignment has no existing row to lock. The partial unique index
 * and ON CONFLICT DO NOTHING prevent two concurrent current Captains. Ended
 * assignments remain history; rows whose Captain was deleted are not current.
 *
 * Conflicts use verified membership, claim ownership, and linked roster IDs,
 * never display names. Unresolved roster members block by default. An operator
 * may acknowledge only the exact unresolved set re-read in the transaction;
 * changed or incomplete acknowledgements fail, and accepted IDs are audited.
 */

/** One row of an "imported roster identity" conflict, or of a "needs review" list — never a display-name match, always this project's own `hq_project_members` row. */
type UnresolvedRosterMember = { memberId: string; name: string; username: string | null };

export type CaptainConflictReason =
  | { kind: "verified_member"; role: "owner" | "member" }
  | { kind: "roster_member"; memberName: string; memberUsername: string | null }
  /** Claim ownership also blocks assignment before verification, even without a linked roster row. */
  | { kind: "claimant" }
  /** The partial unique index arbitrates concurrent first assignments; no existing assignment row can be locked. */
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

  // Serialize roster identity with correctPersonMatch so a concurrent relink
  // cannot make someone captain their own team. Lock people in ID order to
  // avoid cycles between overlapping rosters, separately from the outer join
  // because PostgreSQL cannot lock its nullable side.
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

/** Compare sets, not lengths: duplicate, substituted, or stale IDs cannot acknowledge unseen roster members. */
function acknowledgesExactly(unresolved: UnresolvedRosterMember[], acknowledgedIds: string[] | undefined): boolean {
  if (!acknowledgedIds) return false;
  const current = new Set(unresolved.map((member) => member.memberId));
  const acknowledged = new Set(acknowledgedIds);
  return acknowledged.size === current.size && acknowledgedIds.every((id) => current.has(id));
}

/**
 * Reassignment ends the old row and audits both changes in one transaction.
 * Re-selecting the current Captain is a no-op. Deleted-account rows are ended
 * without an unassignment event because they no longer represent a live Captain.
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

type UnassignCaptainResult =
  | { outcome: "unassigned"; assignmentId: string; captainUserId: string }
  /** Ending a deleted account's orphan row reports no observable change, so callers need not refresh. */
  | { outcome: "not_assigned" }
  | { outcome: "not_found" };

/** Removal only locks assignments: it cannot introduce a membership conflict. */
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

type ClearedCaptainAssignment = { assignmentId: string; projectId: string; projectName: string; hackathonId: number };

/**
 * Clear assignments across every edition in the grant-revocation transaction.
 * Reuse its query handle so the grant, assignments, and audit roll back together.
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

export type CurrentCaptainAssignment = {
  projectId: string; projectName: string; hackathonId: number; captainUserId: string; captainName: string; assignedAt: string;
};

/** Edition-scoped drilldown, optionally restricted to one Captain. */
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

/** Count active-status projects only; the assignment drilldown includes inactive projects too. */
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

type ProjectCaptain = { captainUserId: string; captainName: string };

/** Callers must authorize the viewer on this project before exposing its Captain's name. */
export async function currentCaptainOfProject(db: BuilderQuery, projectId: string): Promise<ProjectCaptain | null> {
  const { rows } = await db.query(
    `SELECT a.captain_user_id AS captain_user_id, b.name AS captain_name
     FROM hq_captain_assignments a JOIN hq_builder_profiles b ON b.id = a.captain_user_id
     WHERE a.project_id = $1::uuid AND a.unassigned_at IS NULL AND a.captain_user_id IS NOT NULL`,
    [projectId],
  );
  return rows.length ? { captainUserId: String(rows[0].captain_user_id), captainName: String(rows[0].captain_name) } : null;
}
