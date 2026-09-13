"use server";

import { headers } from "next/headers";
import { requireMemberActor } from "../actor";
import { currentMemberSession, getAuth } from "../member-auth";
import { getMemberAuthAvailability } from "../member-auth-config";
import { isRecentSession, recordTelegramIntent, telegramIsLastLoginMethod } from "../telegram-identity-plugin";
import { TELEGRAM_PROVIDER_ID } from "../telegram-provider";

// The confirmation step behind Connect and Disconnect Telegram. Each action
// is the server half of an explicit confirmation: it re-checks the rules the
// plugin enforces on the auth endpoints (recent session, one Telegram per
// account, never the last login method) so the page can explain a refusal,
// then records the intent the plugin's /link-social and /unlink-account
// hooks consume. Nothing here links or unlinks: the client calls
// linkSocial() or unlinkAccount() afterwards, and those endpoints refuse a
// request whose intent was never recorded.

export type TelegramConfirmationCode = "SESSION_NOT_FRESH" | "TELEGRAM_UNAVAILABLE" | "TELEGRAM_ALREADY_CONNECTED" | "TELEGRAM_NOT_CONNECTED" | "LAST_LOGIN_METHOD";
export type TelegramLinkConfirmation = { ok: true } | { ok: false; code: TelegramConfirmationCode };
/** `accountId` is the Better Auth account row to pass to unlinkAccount(); it is not a Telegram id. */
export type TelegramUnlinkConfirmation = { ok: true; accountId: string } | { ok: false; code: TelegramConfirmationCode };

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
