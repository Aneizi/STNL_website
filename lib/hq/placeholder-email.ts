/**
 * The placeholder-email rule, alone: no `server-only`, no Better Auth, no
 * `jose` — just the domain constant and the pure check over it. Split out of
 * ./telegram-provider (which re-exports both for every existing import path)
 * so that ./identity, the one definition of "verified account", can depend
 * on this rule without dragging in Better Auth's OAuth machinery. Before
 * this split, `identity.ts -> telegram-provider.ts` was a real edge to a
 * module reserved for the public member auth graph
 * (tests/hq/operator-imports.test.ts), which made isVerifiedAccount
 * unreachable from anywhere sharing a file with an operator action. This is
 * the same shape as `assertHackathonMatches` moving to authz-sql.ts.
 */

/** The library's reserved non-deliverable domain (also used by its anonymous and SIWE plugins). */
export const PLACEHOLDER_DOMAIN = "placeholder.invalid";

/**
 * True for the internal non-deliverable identifier that stands in for an
 * email on Telegram-only accounts (`<sub>@telegram.placeholder.invalid`), and
 * for anything else on the reserved `placeholder.invalid` domain. Such an
 * address is never mailed, never displayed and never synced as a contact.
 */
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return domain === PLACEHOLDER_DOMAIN || domain.endsWith(`.${PLACEHOLDER_DOMAIN}`);
}
