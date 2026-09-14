// Copy for the recovery-email flow: the confirmation action's codes and the
// outcomes of the two change-email endpoints. A sibling of telegram-copy.ts
// in the same style; the codes both flows share (SESSION_NOT_FRESH,
// CONFIRMATION_REQUIRED) resolve through it.
import { telegramErrorMessage } from "../telegram-copy";

/** What the auth client hands back on a failed call. */
export type EndpointError = { code?: string; status?: number; message?: string };

const CODE_MESSAGES: Record<string, string> = {
  EMAIL_DELIVERY_FAILED: "We could not send your code. Please try again shortly.",
  placeholder_email_not_allowed: "This address cannot receive email. Use your own email address.",
  INVALID_OTP: "That code is incorrect or has expired. Try again or request a new one.",
  OTP_EXPIRED: "That code is incorrect or has expired. Try again or request a new one.",
  TOO_MANY_ATTEMPTS: "That code has had too many attempts. Request a new one.",
  TOO_MANY_REQUESTS: "Too many attempts. Please wait a minute and try again.",
  INVALID_EMAIL: "Enter a valid email address.",
};

// The library answers these two without a code; the second is safe to show
// because it is only reached after the code sent to that address was entered.
const MESSAGE_MESSAGES: Record<string, string> = {
  "Email is the same": "That is already the email on this account.",
  "Email already in use": "That address already belongs to another HQ account. Sign in to that account instead, or use a different address.",
};

/** The line for a failed step of the recovery-email flow, or `fallback` when the failure has no better explanation. */
export function emailChangeErrorMessage(error: EndpointError | string | undefined, fallback: string): string {
  const failure: EndpointError = typeof error === "string" ? { code: error } : (error ?? {});
  if (failure.status === 429) return CODE_MESSAGES.TOO_MANY_REQUESTS;
  if (failure.code !== undefined && Object.hasOwn(CODE_MESSAGES, failure.code)) return CODE_MESSAGES[failure.code];
  const shared = telegramErrorMessage(failure.code, "connect");
  if (shared !== null) return shared;
  if (failure.message !== undefined && Object.hasOwn(MESSAGE_MESSAGES, failure.message)) return MESSAGE_MESSAGES[failure.message];
  return fallback;
}
