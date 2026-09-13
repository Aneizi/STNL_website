// Copy for the Telegram sign-in and connection outcomes, keyed by the codes
// the auth endpoints and the OAuth callback produce. Shared by the sign-in
// form (a client component) and the account pages (server components), so
// it lives in a plain module rather than in either of them.

/** Better Auth appends its own `error` to the callback URL after ours, so a page reads the last value. */
export function lastParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[value.length - 1] : value;
}

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
  LAST_LOGIN_METHOD: "Telegram is the only way to sign in to this account, so it cannot be disconnected yet.",
  CONFIRMATION_REQUIRED: "Please confirm this change again.",
  TELEGRAM_UNAVAILABLE: "Telegram sign-in is not available yet.",
};

/**
 * The message for a Telegram outcome code, or null when the code is not a
 * Telegram outcome at all (an unrelated `?error=` is not shown as one).
 * Unknown Telegram callback codes (`telegram`, `unable_to_get_user_info`,
 * `invalid_code`, ...) all mean the same thing to the person: it did not work.
 */
export function telegramErrorMessage(code: string | undefined, action: "signin" | "connect" = "signin"): string | null {
  if (!code) return null;
  if (MESSAGES[code]) return MESSAGES[code];
  if (code === "telegram" || code === "telegram_identity_incomplete" || /^(unable_to_get_user_info|invalid_code|nonce_binding_missing|no_code|issuer_mismatch)$/.test(code)) {
    return action === "connect" ? "We could not connect Telegram. Please try again." : "We could not sign you in with Telegram. Please try again or use email.";
  }
  return null;
}
