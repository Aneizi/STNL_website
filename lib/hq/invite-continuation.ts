import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import type { BuilderQuery } from "./builder-db";
import { memberAuthUsesSecureCookies } from "./member-auth-config";

/**
 * The server-side continuation behind the Captain invitation flow
 * (`INVITE_PATH_PREFIX` in lib/hq/member-routes.ts). The exchange step
 * (app/hq/(member)/invite/[token]/route.ts) turns a bearer token into one of
 * these and never again puts the token in the address; the continuation page
 * and the accept action (lib/hq/actions/invite.ts) read it back by the
 * opaque id an httpOnly cookie carries — never a token, never the invitation
 * id itself.
 *
 * Reuses hq_auth_verification, Better Auth's own generic expiring-value
 * table, the same way lib/hq/telegram-identity-plugin.ts's
 * recordTelegramIntent already does. That function keys by user id, which an
 * invitation visitor may not have yet, so this keys by a fresh random id
 * instead. And because no Better Auth endpoint ever needs to read this
 * value — unlike a telegram intent, nothing here crosses into the auth
 * library's own hooks — the row is written and read directly through the
 * shared builder pool rather than through Better Auth's internalAdapter.
 * That keeps this module testable against PGlite exactly like every other
 * builder-side module, with no live Better Auth instance required.
 */

const IDENTIFIER_PREFIX = "hq-invite-continuation:";

/**
 * Long enough to survive a sign-up, not just a sign-in: the email OTP itself
 * expires in 15 minutes (lib/hq/member-auth.ts), but reading the mail and
 * typing the code takes real time, and a visitor may need one resend. Short
 * enough that an abandoned or leaked continuation is worthless within the
 * hour — it names an invitation, not a grant, so the blast radius of a leak
 * is small, but there is no reason to keep it around longer than the flow
 * needs.
 */
export const INVITE_CONTINUATION_TTL_MS = 30 * 60 * 1000;

/** Not a Better Auth cookie (those all carry `stnl_builder`); set and read only by this flow. */
export const INVITE_CONTINUATION_COOKIE = "hq_invite_continuation";

/** Where the continuation cookie is sent: the whole /hq/invite/ subtree, never wider than the flow that needs it. */
const INVITE_CONTINUATION_COOKIE_PATH = "/hq/invite";

export type InviteContinuation = {
  invitationId: string;
  /**
   * A best-effort snapshot of readCaptainInvitationByToken at exchange time,
   * for the continuation page's pre-acceptance display only. Never trusted
   * for the grant itself: acceptCaptainInvitation re-derives every one of
   * these, under its own row lock, when the accept action calls it.
   */
  expired: boolean;
  revoked: boolean;
  full: boolean;
};

export type InviteContinuationCookieOptions = {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
};

/** The Set-Cookie options for the continuation cookie, matching the member session's own secure-cookie policy. */
export function inviteContinuationCookieOptions(): InviteContinuationCookieOptions {
  return {
    httpOnly: true,
    secure: memberAuthUsesSecureCookies(),
    sameSite: "lax",
    path: INVITE_CONTINUATION_COOKIE_PATH,
    maxAge: Math.floor(INVITE_CONTINUATION_TTL_MS / 1000),
  };
}

/** A fresh opaque id for the cookie: 24 random bytes, unrelated to the invitation token, so it can never be used to derive or replay one. */
export function newInviteContinuationId(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Stores a continuation keyed by an id the caller generated with
 * newInviteContinuationId(). Opportunistically clears this module's own
 * expired rows first, the same per-namespace housekeeping
 * lib/hq/colosseum-interest.ts does for its rate-limit rows.
 */
export async function recordInviteContinuation(db: BuilderQuery, id: string, continuation: InviteContinuation): Promise<void> {
  await db.query(`DELETE FROM hq_auth_verification WHERE identifier LIKE $1 AND "expiresAt" < now()`, [`${IDENTIFIER_PREFIX}%`]);
  await db.query(
    `INSERT INTO hq_auth_verification (id, identifier, value, "expiresAt") VALUES ($1, $2, $3, $4)`,
    [randomUUID(), `${IDENTIFIER_PREFIX}${id}`, JSON.stringify(continuation), new Date(Date.now() + INVITE_CONTINUATION_TTL_MS).toISOString()],
  );
}

/**
 * Reads a continuation back by its cookie id. Null for a missing, forged,
 * unknown, malformed or expired one — every one of those cases must render
 * identically on the continuation page, so this deliberately throws away
 * which case it was.
 */
export async function readInviteContinuation(db: BuilderQuery, id: string): Promise<InviteContinuation | null> {
  if (!id) return null;
  const { rows } = await db.query(
    `SELECT value FROM hq_auth_verification WHERE identifier = $1 AND "expiresAt" > now() ORDER BY "createdAt" DESC LIMIT 1`,
    [`${IDENTIFIER_PREFIX}${id}`],
  );
  if (!rows.length) return null;
  try {
    const parsed: unknown = JSON.parse(String(rows[0].value));
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { invitationId?: unknown }).invitationId !== "string") return null;
    const value = parsed as { invitationId: string; expired?: unknown; revoked?: unknown; full?: unknown };
    return { invitationId: value.invitationId, expired: Boolean(value.expired), revoked: Boolean(value.revoked), full: Boolean(value.full) };
  } catch {
    return null;
  }
}
