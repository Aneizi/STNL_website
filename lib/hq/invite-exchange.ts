import "server-only";
import type { BuilderQuery } from "./builder-db";
import { readCaptainInvitationByToken } from "./captains";
import { newInviteContinuationId, recordInviteContinuation } from "./invite-continuation";

/**
 * Step 1 of the Captain invitation flow: exchanging a bearer token in the
 * address for a short-lived, tokenless continuation
 * (lib/hq/invite-continuation.ts). Called only from the GET handler at
 * app/hq/(member)/invite/[token]/route.ts, kept separate from it so the
 * exchange logic is testable against PGlite without any Next.js request or
 * cookie machinery, the way every other builder-side service in this repo is.
 */

const IP_RATE_LIMIT_WINDOW_MINUTES = 15;

/**
 * Limits guesses of the six-character invitation codes before looking one
 * up or issuing a continuation. Keyed by the requesting
 * address rather than a user id — an exchange visitor may have no account —
 * reusing hq_login_limits' fixed-window counter under its own key namespace,
 * the same way lib/hq/actions/auth.ts (operator login) and
 * lib/hq/colosseum-interest.ts (a public form) already rate-limit anonymous
 * requests. 30 requests per 15 minutes comfortably covers a shared office
 * address retrying a stale link or a preview bot refetching it, while still
 * bounding an automated scan.
 */
const IP_MAX_EXCHANGES = 30;

async function withinExchangeRateLimit(db: BuilderQuery, ip: string): Promise<boolean> {
  const key = `invite-exchange:ip:${ip}`;
  await db.query(`DELETE FROM hq_login_limits WHERE key LIKE 'invite-exchange:ip:%' AND window_start < now() - interval '1 day'`);
  const { rows } = await db.query(
    `INSERT INTO hq_login_limits AS l (key, count, window_start)
     VALUES ($1, 1, now())
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN l.window_start < now() - interval '${IP_RATE_LIMIT_WINDOW_MINUTES} minutes' THEN 1 ELSE l.count + 1 END,
       window_start = CASE WHEN l.window_start < now() - interval '${IP_RATE_LIMIT_WINDOW_MINUTES} minutes' THEN now() ELSE l.window_start END
     RETURNING count`,
    [key],
  );
  return Number(rows[0].count) <= IP_MAX_EXCHANGES;
}

export type InviteExchangeResult = { continuationId: string | null };

/**
 * Turns a bearer token into a continuation. A pure read of the invitation
 * (readCaptainInvitationByToken — no lock, no write to any invitation table)
 * plus, when the token resolves, one continuation write. Never a redemption.
 *
 * `continuationId` is null for a rate-limited address and for an unknown
 * token alike: the caller (the route handler) redirects to the continuation
 * page either way, without setting a cookie, and that page's "no valid
 * continuation" branch is the same one a forged or expired continuation id
 * hits — a guesser learns nothing about which case it was.
 *
 * An expired, revoked or already-full token still gets a continuation: the
 * invitation exists and the continuation page explains why it cannot be
 * accepted, using the snapshot captured here. What never happens for any of
 * these outcomes is a write to hq_captain_invitations or
 * hq_captain_invitation_redemptions.
 */
export async function exchangeCaptainInvitationToken(db: BuilderQuery, input: { token: string; ip: string }): Promise<InviteExchangeResult> {
  if (!(await withinExchangeRateLimit(db, input.ip))) return { continuationId: null };
  const invitation = await readCaptainInvitationByToken(db, input.token);
  if (!invitation) return { continuationId: null };
  const continuationId = newInviteContinuationId();
  await recordInviteContinuation(db, continuationId, { invitationId: invitation.id, expired: invitation.expired, revoked: invitation.revoked, full: invitation.full });
  return { continuationId };
}
