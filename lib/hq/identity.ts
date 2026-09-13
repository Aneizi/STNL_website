import "server-only";
import { builderDatabase } from "./builder-store";

/**
 * A verified Telegram identity attached to a public HQ account. The numeric
 * Telegram user id is a bigint in PostgreSQL and a string here, so it never
 * passes through a JavaScript number at a JSON boundary.
 */
export type TelegramIdentity = {
  userId: string;
  telegramUserId: string;
  providerSubject: string;
  username: string | null;
  photoUrl: string | null;
  linkedAt: string;
  lastLoginAt: string;
};

// Reads and writes for hq_auth_telegram_identity go through the same pg pool
// the builder store uses. That pool is separate from Better Auth's own pool,
// so nothing here can observe an uncommitted Better Auth transaction.
const COLUMNS = `user_id, provider_subject, telegram_user_id::text AS telegram_user_id, username, photo_url, linked_at, last_login_at`;

function toIdentity(row: Record<string, unknown>): TelegramIdentity {
  return {
    userId: String(row.user_id),
    telegramUserId: String(row.telegram_user_id),
    providerSubject: String(row.provider_subject),
    username: row.username == null ? null : String(row.username),
    photoUrl: row.photo_url == null ? null : String(row.photo_url),
    linkedAt: new Date(String(row.linked_at)).toISOString(),
    lastLoginAt: new Date(String(row.last_login_at)).toISOString(),
  };
}

export async function getTelegramIdentity(userId: string): Promise<TelegramIdentity | null> {
  const { rows } = await builderDatabase().query(`SELECT ${COLUMNS} FROM hq_auth_telegram_identity WHERE user_id = $1`, [userId]);
  return rows.length ? toIdentity(rows[0]) : null;
}

export async function hasTelegramIdentity(userId: string): Promise<boolean> {
  const { rows } = await builderDatabase().query(`SELECT 1 FROM hq_auth_telegram_identity WHERE user_id = $1`, [userId]);
  return rows.length > 0;
}

export type TelegramIdentityInput = {
  userId: string;
  telegramUserId: string;
  providerSubject: string;
  username: string | null;
  photoUrl: string | null;
};

/** The id of another account already holding this subject or Telegram user id, if any. */
export async function findTelegramIdentityConflict(input: Pick<TelegramIdentityInput, "userId" | "telegramUserId" | "providerSubject">): Promise<string | null> {
  const { rows } = await builderDatabase().query(
    `SELECT user_id FROM hq_auth_telegram_identity
     WHERE (telegram_user_id = $1::bigint OR provider_subject = $2) AND user_id <> $3 LIMIT 1`,
    [input.telegramUserId, input.providerSubject, input.userId],
  );
  return rows.length ? String(rows[0].user_id) : null;
}

/** Idempotent: a repeat login refreshes the snapshot and last_login_at only. */
export async function upsertTelegramIdentity(input: TelegramIdentityInput): Promise<void> {
  await builderDatabase().query(
    `INSERT INTO hq_auth_telegram_identity (user_id, provider_subject, telegram_user_id, username, photo_url)
     VALUES ($1, $2, $3::bigint, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       provider_subject = EXCLUDED.provider_subject,
       telegram_user_id = EXCLUDED.telegram_user_id,
       username = EXCLUDED.username,
       photo_url = EXCLUDED.photo_url,
       last_login_at = now()`,
    [input.userId, input.providerSubject, input.telegramUserId, input.username, input.photoUrl],
  );
}

export async function deleteTelegramIdentity(userId: string): Promise<void> {
  await builderDatabase().query(`DELETE FROM hq_auth_telegram_identity WHERE user_id = $1`, [userId]);
}
