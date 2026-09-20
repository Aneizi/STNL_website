import "server-only";
import type { BuilderQuery } from "./builder-db";
import { readCaptainInvitationByToken } from "./captains";
import { newInviteContinuationId, recordInviteContinuation } from "./invite-continuation";
import { hitRateLimit } from "./rate-limit";

/**
 * Step 1 of the Captain invitation flow: exchanging a bearer token in the
 * address for a short-lived, tokenless continuation
 * (lib/hq/invite-continuation.ts). Called only from the GET handler at
 * app/hq/(member)/invite/[token]/route.ts, kept separate from it so the
 * exchange logic is testable against PGlite without any Next.js request or
 * cookie machinery, the way every other builder-side service in this repo is.
 */

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
  return (await hitRateLimit(db, `invite-exchange:ip:${ip}`, { max: IP_MAX_EXCHANGES })).allowed;
}

type InviteExchangeResult = { continuationId: string | null };

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
