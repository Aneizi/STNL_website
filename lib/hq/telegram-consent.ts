import "server-only";
import type { MemberActor } from "./actor";
import { recordAuditEvent } from "./audit";
import { builderDatabase, type BuilderQuery } from "./builder-db";
import { getTelegramIdentity } from "./identity";
import { activeTelegramIdentitySql } from "./telegram-identity-sql";

/**
 * Permission to be messaged by the HQ Telegram bot, kept apart from the
 * Telegram identity. Connecting Telegram proves who the person is; this row
 * records whether they agreed to be messaged. Neither implies the other:
 * an account with Telegram connected and messaging disabled has full website
 * access, and disconnecting Telegram revokes messaging in the same operation
 * (the identity plugin calls `revokeBotConsent` from its unlink hook).
 * Nothing reads this row to deliver a message before phase 7.
 */
type BotConsent = {
  userId: string;
  /** The Telegram user id the consent was given for, as a string like everywhere else. */
  telegramUserId: string;
  messagingEnabled: boolean;
  /**
   * Whether the Telegram connected now has already opened the bot chat, so
   * nothing more is needed to reach this account. Turning messaging off never
   * loses it: the binding is kept until the identity behind it goes away.
   */
  chatStarted: boolean;
  consentedAt: string | null;
  revokedAt: string | null;
  updatedAt: string;
};

/** Thrown by `setBotConsent` when the actor has no Telegram identity: there is nobody to message. */
export class TelegramNotConnectedError extends Error {
  constructor() {
    super("This account has no Telegram connection.");
    this.name = "TelegramNotConnectedError";
  }
}

/**
 * A bound chat counts only while the identity that opened it is the one still
 * connected, the same rule deliverableBotChat() sends by. Computed rather
 * than stored, so a relink or an unlink cleanup cannot leave it stale.
 */
const CHAT_STARTED = `(chat_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM hq_auth_telegram_identity i
    WHERE i.user_id = hq_telegram_bot_consent.user_id
      AND i.telegram_user_id = hq_telegram_bot_consent.chat_bound_telegram_user_id
      AND ${activeTelegramIdentitySql()}
  )) AS chat_started`;

const COLUMNS = `user_id, telegram_user_id::text AS telegram_user_id, messaging_enabled, ${CHAT_STARTED}, consented_at, revoked_at, updated_at`;

const toIso = (value: unknown) => (value instanceof Date ? value : new Date(String(value))).toISOString();

function toConsent(row: Record<string, unknown>): BotConsent {
  return {
    userId: String(row.user_id),
    telegramUserId: String(row.telegram_user_id),
    messagingEnabled: Boolean(row.messaging_enabled),
    chatStarted: Boolean(row.chat_started),
    consentedAt: row.consented_at == null ? null : toIso(row.consented_at),
    revokedAt: row.revoked_at == null ? null : toIso(row.revoked_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** The stored decision, or null when the account never enabled bot messages. Null and `messagingEnabled: false` mean the same thing to a sender. */
export async function getBotConsent(userId: string, db: BuilderQuery = builderDatabase()): Promise<BotConsent | null> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM hq_telegram_bot_consent WHERE user_id = $1`, [userId]);
  return rows.length ? toConsent(rows[0]) : null;
}

/** Audit metadata for a consent change: the new state and, when it was not the person's own choice, why. */
type ConsentAuditMetadata = { enabled: boolean; cause?: "telegram_disconnected" };

/**
 * Records the member's decision. Requires a Telegram identity, read again at
 * write time so the row names the Telegram account that exists now, not the
 * one the actor was built from. Idempotent: asking for the state the account
 * is already in writes nothing and records nothing. A change and its
 * `bot.consent_changed` audit event commit together.
 */
export async function setBotConsent(actor: Pick<MemberActor, "kind" | "id">, enabled: boolean): Promise<BotConsent> {
  const identity = await getTelegramIdentity(actor.id);
  if (!identity) throw new TelegramNotConnectedError();
  return builderDatabase().transaction(async (db) => {
    const current = await getBotConsent(actor.id, db);
    if ((current?.messagingEnabled ?? false) === enabled) {
      return current ?? { userId: actor.id, telegramUserId: identity.telegramUserId, messagingEnabled: false, chatStarted: false, consentedAt: null, revokedAt: null, updatedAt: new Date().toISOString() };
    }
    const { rows } = await db.query(
      `INSERT INTO hq_telegram_bot_consent (user_id, telegram_user_id, messaging_enabled, consented_at, revoked_at)
       VALUES ($1, $2::bigint, $3::boolean, CASE WHEN $3::boolean THEN now() END, CASE WHEN $3::boolean THEN NULL ELSE now() END)
       ON CONFLICT (user_id) DO UPDATE SET
         telegram_user_id = EXCLUDED.telegram_user_id,
         messaging_enabled = EXCLUDED.messaging_enabled,
         -- A different Telegram account is a different destination. Agreeing
         -- to be messaged says nothing about a chat the PREVIOUS account
         -- opened, so the binding is dropped and has to be re-established by
         -- the new account messaging the bot. Without this, disconnecting
         -- Telegram, connecting a different account and turning messages back
         -- on delivered into the old account's private chat, which an
         -- external review reproduced on 15 September 2026.
         chat_id = CASE WHEN hq_telegram_bot_consent.chat_bound_telegram_user_id IS DISTINCT FROM EXCLUDED.telegram_user_id THEN NULL ELSE hq_telegram_bot_consent.chat_id END,
         chat_bound_telegram_user_id = CASE WHEN hq_telegram_bot_consent.chat_bound_telegram_user_id IS DISTINCT FROM EXCLUDED.telegram_user_id THEN NULL ELSE hq_telegram_bot_consent.chat_bound_telegram_user_id END,
         consented_at = CASE WHEN EXCLUDED.messaging_enabled THEN now() ELSE hq_telegram_bot_consent.consented_at END,
         revoked_at = CASE WHEN EXCLUDED.messaging_enabled THEN NULL ELSE now() END,
         updated_at = now()
       RETURNING ${COLUMNS}`,
      [actor.id, identity.telegramUserId, enabled],
    );
    const metadata: ConsentAuditMetadata = { enabled };
    await recordAuditEvent(db, { kind: "bot.consent_changed", actor: { kind: "member", id: actor.id }, subjectUserId: actor.id, metadata });
    return toConsent(rows[0]);
  });
}

/**
 * Turns messaging off because the Telegram identity is going away. Writes
 * through the caller's query handle so it commits with the identity removal.
 * True when an enabled consent was revoked; false when there was nothing to
 * revoke, in which case no audit event is written either.
 */
export async function revokeBotConsent(userId: string, db: BuilderQuery): Promise<boolean> {
  // The chat binding goes with the identity, not with the consent: the
  // identity that opened that chat is the one being removed, so the chat is
  // no longer a destination this account has any claim to. Cleared
  // unconditionally, because a row with messaging already off still carries a
  // chat id that a later re-consent would otherwise inherit.
  await db.query(
    "UPDATE hq_telegram_bot_consent SET chat_id = NULL, chat_bound_telegram_user_id = NULL, updated_at = now() WHERE user_id = $1",
    [userId],
  );
  const { rows } = await db.query(
    `UPDATE hq_telegram_bot_consent SET messaging_enabled = false, revoked_at = now(), updated_at = now()
     WHERE user_id = $1 AND messaging_enabled RETURNING user_id`,
    [userId],
  );
  if (!rows.length) return false;
  const metadata: ConsentAuditMetadata = { enabled: false, cause: "telegram_disconnected" };
  await recordAuditEvent(db, { kind: "bot.consent_changed", actor: { kind: "member", id: userId }, subjectUserId: userId, metadata });
  return true;
}
