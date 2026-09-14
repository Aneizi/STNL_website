// Copy for the Telegram sign-in and connection outcomes, keyed by the codes
// the auth endpoints and the OAuth callback produce. Shared by the sign-in
// form (a client component) and the account pages (server components), so
// it lives in a plain module rather than in either of them.

/** Better Auth appends its own value after ours, so a page that wants one value reads the last. */
export function lastParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[value.length - 1] : value;
}

export type TelegramAction = "signin" | "connect";

/** Shown wherever Telegram is the only way in: the account page, the disconnect step and the action's refusal. */
export const LAST_LOGIN_METHOD_COPY = "Telegram is the only way to sign in to this account, so it cannot be disconnected. Add a verified email first.";

const ALREADY_CONNECTED_ELSEWHERE = "This Telegram account is already connected to another HQ account. Sign in to that account instead.";

const MESSAGES: Record<string, string> = {
  account_already_linked_to_different_user: ALREADY_CONNECTED_ELSEWHERE,
  telegram_identity_conflict: ALREADY_CONNECTED_ELSEWHERE,
  state_mismatch: "That Telegram link has expired or was already used. Please start again.",
  SESSION_NOT_FRESH: "Please sign in again to continue.",
  identity_missing: "Your Telegram sign-in did not complete. Please sign in again.",
  TELEGRAM_ALREADY_CONNECTED: "This account already has a Telegram connection.",
  telegram_already_connected: "This account already has a Telegram connection.",
  TELEGRAM_NOT_CONNECTED: "This account has no Telegram connection.",
  LAST_LOGIN_METHOD: LAST_LOGIN_METHOD_COPY,
  CONFIRMATION_REQUIRED: "Please confirm this change again.",
  TELEGRAM_UNAVAILABLE: "Telegram sign-in is not available yet.",
  EMAIL_UNAVAILABLE: "Email is not available yet.",
  INVALID_EMAIL: "Enter a valid email address.",
  EMAIL_UNCHANGED: "That is already the email on this account.",
};

/** Own keys only: `in` would also find `__proto__`, `constructor` and the rest of Object.prototype, and a URL can carry any of those. */
const knownCode = (value: string): boolean => Object.hasOwn(MESSAGES, value);

/** The line for a Telegram attempt that did not work for a reason the person cannot act on. */
export function telegramFailure(action: TelegramAction): string {
  return action === "connect" ? "We could not connect Telegram. Please try again." : "We could not sign you in with Telegram. Please try again.";
}

/**
 * The message for the `error` values a Telegram outcome left in the URL, or
 * null when none of them is a Telegram outcome (an unrelated `?error=` is not
 * shown as one). Our own `errorCallbackURL` carries `telegram`; the callback
 * appends its code after it, so a value is looked up wherever it sits. A
 * mapped code wins; any other code next to `telegram` (`access_denied` when
 * the person cancels at Telegram, `unable_to_get_user_info`, `invalid_code`,
 * ...) means the same thing to them: it did not work.
 */
export function telegramErrorMessage(error: string | string[] | undefined, action: TelegramAction = "signin"): string | null {
  const values = error === undefined ? [] : Array.isArray(error) ? error : [error];
  const mapped = values.filter(knownCode);
  if (mapped.length) return MESSAGES[mapped[mapped.length - 1]];
  return values.includes("telegram") ? telegramFailure(action) : null;
}
