"use server";

import { headers } from "next/headers";
import { requireMemberActor } from "../actor";
import { currentMemberSession, getAuth } from "../member-auth";
import { getMemberAuthAvailability } from "../member-auth-config";
import { setBotConsent, TelegramNotConnectedError } from "../telegram-consent";
import { isRecentSession, normalizeEmailAddress, recordTelegramIntent, telegramIsLastLoginMethod } from "../telegram-identity-plugin";
import { isPlaceholderEmail, TELEGRAM_PROVIDER_ID } from "../telegram-provider";

// The confirmation step behind Connect Telegram, Disconnect Telegram and Add
// a recovery email. Each action is the server half of an explicit
// confirmation: it re-checks the rules the plugin enforces on the auth
// endpoints (recent session, one Telegram per account, never the last login
// method, never a placeholder address) so the page can explain a refusal,
// then records the intent the plugin's endpoint hooks consume. Nothing here
// links, unlinks or changes an email: the client calls linkSocial(),
// unlinkAccount() or the emailOtp change-email endpoints afterwards, and
// those refuse a request whose intent was never recorded. Bot messaging is
// not a login method, so setBotMessaging() writes directly.

export type TelegramConfirmationCode = "SESSION_NOT_FRESH" | "TELEGRAM_UNAVAILABLE" | "TELEGRAM_ALREADY_CONNECTED" | "TELEGRAM_NOT_CONNECTED" | "LAST_LOGIN_METHOD";
export type TelegramLinkConfirmation = { ok: true } | { ok: false; code: TelegramConfirmationCode };
/** `accountId` is the Better Auth account row to pass to unlinkAccount(); it is not a Telegram id. */
export type TelegramUnlinkConfirmation = { ok: true; accountId: string } | { ok: false; code: TelegramConfirmationCode };
export type EmailChangeConfirmationCode = "SESSION_NOT_FRESH" | "EMAIL_UNAVAILABLE" | "INVALID_EMAIL" | "EMAIL_UNCHANGED" | "EMAIL_ALREADY_SET";
/** `newEmail` is the normalized address the intent was recorded for; the client sends exactly that to the endpoints. */
export type EmailChangeConfirmation = { ok: true; newEmail: string } | { ok: false; code: EmailChangeConfirmationCode };
export type BotMessagingResult = { ok: true; enabled: boolean } | { ok: false; code: "TELEGRAM_NOT_CONNECTED" };

/** Shape only; the endpoints validate again and refuse anything they cannot mail. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function intentStore() {
  return (await getAuth().$context).internalAdapter;
}

export async function confirmLinkTelegram(): Promise<TelegramLinkConfirmation> {
  const actor = await requireMemberActor("/hq/account/connect-telegram");
  if (!getMemberAuthAvailability().telegram) return { ok: false, code: "TELEGRAM_UNAVAILABLE" };
  if (actor.telegram) return { ok: false, code: "TELEGRAM_ALREADY_CONNECTED" };
  const session = await currentMemberSession();
  if (!session || !isRecentSession(session.session)) return { ok: false, code: "SESSION_NOT_FRESH" };
  await recordTelegramIntent(await intentStore(), actor.id, "link");
  return { ok: true };
}

export async function confirmUnlinkTelegram(): Promise<TelegramUnlinkConfirmation> {
  const actor = await requireMemberActor("/hq/account/disconnect-telegram");
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
 * Confirms adding a login email to an account that has none: the recovery
 * email for a Telegram-first account, and nothing else. An account that
 * already signs in with an email is refused here, not only redirected by the
 * page: an action is directly callable, and /email-otp/change-email is
 * configured with verifyCurrentEmail false (no code goes to the current
 * address, because a Telegram-first account has none to send one to), so
 * without this an attacker holding a fresh session could move an existing
 * account's login address to one they control. Changing a verified address
 * is not a product feature; if it becomes one it needs a code to the current
 * address, not this endpoint.
 *
 * Adding a login method is as sensitive as removing one, so the same recency
 * window applies. The placeholder is never a valid new address, whatever the
 * session holds. Whether the address is taken is not checked here or anywhere
 * the client can see: the endpoint answers the same either way and simply
 * sends no code to an address that belongs to another account.
 */
export async function confirmEmailChange(newEmail: string): Promise<EmailChangeConfirmation> {
  const actor = await requireMemberActor("/hq/account/add-email");
  if (!getMemberAuthAvailability().email) return { ok: false, code: "EMAIL_UNAVAILABLE" };
  // actor.email is the verified login email; an account that has one has
  // nothing to add here, the same rule the page redirects on.
  if (actor.email !== null) return { ok: false, code: "EMAIL_ALREADY_SET" };
  const address = normalizeEmailAddress(newEmail);
  if (address.length > 254 || !EMAIL_SHAPE.test(address) || isPlaceholderEmail(address)) return { ok: false, code: "INVALID_EMAIL" };
  const session = await currentMemberSession();
  if (!session || !isRecentSession(session.session)) return { ok: false, code: "SESSION_NOT_FRESH" };
  // Only an unverified stored address reaches this: a verified one was refused
  // above, and the placeholder is null on the session and invalid as input.
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
