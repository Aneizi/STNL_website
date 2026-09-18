"use server";

import { headers } from "next/headers";
import { requireMemberActor } from "../actor";
import { currentMemberSession, getAuth } from "../member-auth";
import { getMemberAuthAvailability } from "../member-auth-config";
import { setBotConsent, TelegramNotConnectedError } from "../telegram-consent";
import { isRecentSession, normalizeEmailAddress, recordTelegramIntent, telegramIsLastLoginMethod } from "../telegram-identity-plugin";
import { isPlaceholderEmail, TELEGRAM_PROVIDER_ID } from "../telegram-provider";

// The confirmation step behind the account page's three modals: Connect
// Telegram, Disconnect Telegram, and Add or Change email. Each action is the
// server half of an explicit confirmation: it re-checks the rules the plugin
// enforces on the auth endpoints (recent session, one Telegram per account,
// never the last login method, never a placeholder address) so the modal can
// explain a refusal, then records the intent the plugin's endpoint hooks
// consume. Nothing here links, unlinks or changes an email: the client calls
// linkSocial(), unlinkAccount() or the emailOtp change-email endpoints
// afterwards, and those refuse a request whose intent was never recorded.
// Bot messaging is not a login method, so setBotMessaging() writes directly.
// Every gate names the account page: it is where a member who has to sign in
// again comes back to.

export type TelegramConfirmationCode = "SESSION_NOT_FRESH" | "TELEGRAM_UNAVAILABLE" | "TELEGRAM_ALREADY_CONNECTED" | "TELEGRAM_NOT_CONNECTED" | "LAST_LOGIN_METHOD";
export type TelegramLinkConfirmation = { ok: true } | { ok: false; code: TelegramConfirmationCode };
/** `accountId` is the Better Auth account row to pass to unlinkAccount(); it is not a Telegram id. */
export type TelegramUnlinkConfirmation = { ok: true; accountId: string } | { ok: false; code: TelegramConfirmationCode };
export type EmailChangeConfirmationCode = "SESSION_NOT_FRESH" | "EMAIL_UNAVAILABLE" | "INVALID_EMAIL" | "EMAIL_UNCHANGED";
/** `newEmail` is the normalized address the intent was recorded for; the client sends exactly that to the endpoints. */
export type EmailChangeConfirmation = { ok: true; newEmail: string } | { ok: false; code: EmailChangeConfirmationCode };
export type BotMessagingResult = { ok: true; enabled: boolean } | { ok: false; code: "TELEGRAM_NOT_CONNECTED" };

/** Shape only; the endpoints validate again and refuse anything they cannot mail. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function intentStore() {
  return (await getAuth().$context).internalAdapter;
}

export async function confirmLinkTelegram(): Promise<TelegramLinkConfirmation> {
  const actor = await requireMemberActor("/hq/account");
  if (!getMemberAuthAvailability().telegram) return { ok: false, code: "TELEGRAM_UNAVAILABLE" };
  if (actor.telegram) return { ok: false, code: "TELEGRAM_ALREADY_CONNECTED" };
  const session = await currentMemberSession();
  if (!session || !isRecentSession(session.session)) return { ok: false, code: "SESSION_NOT_FRESH" };
  await recordTelegramIntent(await intentStore(), actor.id, "link");
  return { ok: true };
}

export async function confirmUnlinkTelegram(): Promise<TelegramUnlinkConfirmation> {
  const actor = await requireMemberActor("/hq/account");
  if (!actor.telegram) return { ok: false, code: "TELEGRAM_NOT_CONNECTED" };
  const session = await currentMemberSession();
  if (!session || !isRecentSession(session.session)) return { ok: false, code: "SESSION_NOT_FRESH" };
  if (telegramIsLastLoginMethod(session.user)) return { ok: false, code: "LAST_LOGIN_METHOD" };
  const accounts = await getAuth().api.listUserAccounts({ headers: await headers() });
  const account = accounts.find((candidate) => candidate.providerId === TELEGRAM_PROVIDER_ID);
  if (!account) return { ok: false, code: "TELEGRAM_NOT_CONNECTED" };
  await recordTelegramIntent(await intentStore(), actor.id, "unlink");
  return { ok: true, accountId: account.id };
}

/**
 * Confirms a new login email: the recovery email of a Telegram-first account,
 * or a replacement for the verified address an account already signs in
 * with. In both cases the code goes to the NEW address only:
 * /email-otp/change-email runs with verifyCurrentEmail false, so the current
 * address is never asked to approve the move. That is the accepted trade-off
 * behind the account page's "Change email": a Telegram-first account has no
 * current address to ask, and a member who has lost access to their old
 * mailbox must still be able to move the account. What stands in for that
 * approval: the member gate, a session created within the recency window
 * (a session cookie older than that cannot use this, however it was
 * obtained), the recorded intent bound to the one confirmed address, and
 * the user.update.after hook in member-auth.ts, which tells the previous
 * verified address and audits identity.email_changed.
 *
 * Adding a login method is as sensitive as removing one, so the same recency
 * window applies. The placeholder is never a valid new address, whatever the
 * session holds. Whether the address is taken is not checked here or anywhere
 * the client can see: the endpoint answers the same either way and simply
 * sends no code to an address that belongs to another account.
 */
export async function confirmEmailChange(newEmail: string): Promise<EmailChangeConfirmation> {
  const actor = await requireMemberActor("/hq/account");
  if (!getMemberAuthAvailability().email) return { ok: false, code: "EMAIL_UNAVAILABLE" };
  const address = normalizeEmailAddress(newEmail);
  if (address.length > 254 || !EMAIL_SHAPE.test(address) || isPlaceholderEmail(address)) return { ok: false, code: "INVALID_EMAIL" };
  const session = await currentMemberSession();
  if (!session || !isRecentSession(session.session)) return { ok: false, code: "SESSION_NOT_FRESH" };
  // session.user.email is the stored real address, verified or not, and null
  // for a Telegram-only account (the placeholder never reaches a session), so
  // the current address is the one thing that cannot be "changed" to.
  if (address === normalizeEmailAddress(session.user.email)) return { ok: false, code: "EMAIL_UNCHANGED" };
  await recordTelegramIntent(await intentStore(), actor.id, "change-email", address);
  return { ok: true, newEmail: address };
}

/** Enables or disables bot messages for the signed-in member. Independent of the identity link; refused only when there is no Telegram to message. */
export async function setBotMessaging(enabled: boolean): Promise<BotMessagingResult> {
  const actor = await requireMemberActor("/hq/account");
  try {
    const consent = await setBotConsent(actor, enabled === true);
    return { ok: true, enabled: consent.messagingEnabled };
  } catch (error) {
    if (error instanceof TelegramNotConnectedError) return { ok: false, code: "TELEGRAM_NOT_CONNECTED" };
    throw error;
  }
}
