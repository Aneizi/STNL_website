import "server-only";
import type { BuilderQuery } from "./builder-db";
import { builderDatabase, builderStore } from "./builder-store";
import { isPlaceholderEmail } from "./placeholder-email";

// The rule for the internal placeholder address lives in ./placeholder-email
// (not ./telegram-provider, which is reserved for the public member auth
// graph — tests/hq/operator-imports.test.ts) and is re-exported here because
// this module is the identity boundary every other module reads.
export { isPlaceholderEmail } from "./placeholder-email";

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

/** pg hands timestamptz back as a Date; keep its full precision instead of re-parsing text. */
const toIso = (value: unknown) => (value instanceof Date ? value : new Date(String(value))).toISOString();

function toIdentity(row: Record<string, unknown>): TelegramIdentity {
  return {
    userId: String(row.user_id),
    telegramUserId: String(row.telegram_user_id),
    providerSubject: String(row.provider_subject),
    username: row.username == null ? null : String(row.username),
    photoUrl: row.photo_url == null ? null : String(row.photo_url),
    linkedAt: toIso(row.linked_at),
    lastLoginAt: toIso(row.last_login_at),
  };
}

export async function getTelegramIdentity(userId: string): Promise<TelegramIdentity | null> {
  const { rows } = await builderDatabase().query(`SELECT ${COLUMNS} FROM hq_auth_telegram_identity WHERE user_id = $1`, [userId]);
  return rows.length ? toIdentity(rows[0]) : null;
}

/**
 * The account a Telegram user id belongs to, or null.
 *
 * The bot's identity binding, and the only one it has: a webhook payload
 * names a Telegram user, and this row is what turns that into an HQ account.
 * Read on every update rather than remembered, so unlinking Telegram closes
 * the bot on the next message with nothing else to revoke.
 *
 * `telegramUserId` is a string here as everywhere else and is cast to bigint
 * in the query; a value that is not a run of digits is refused before the
 * cast, so a malformed payload is a miss rather than a database error.
 */
export async function findTelegramIdentityByTelegramUserId(
  telegramUserId: string,
  db: BuilderQuery = builderDatabase(),
): Promise<TelegramIdentity | null> {
  if (!/^\d{1,19}$/.test(String(telegramUserId ?? ""))) return null;
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM hq_auth_telegram_identity WHERE telegram_user_id = $1::bigint`, [telegramUserId]);
  return rows.length ? toIdentity(rows[0]) : null;
}

export async function hasTelegramIdentity(userId: string): Promise<boolean> {
  const { rows } = await builderDatabase().query(`SELECT 1 FROM hq_auth_telegram_identity WHERE user_id = $1`, [userId]);
  return rows.length > 0;
}

/**
 * The stored account fields the verified-account rule reads. `email` is a
 * string as Better Auth hands the row to a database hook, and null on a
 * session, where the customSession transform in ./member-auth has already
 * replaced the internal placeholder. Both answer this rule the same way.
 */
export type StoredAccount = { id: string; email: string | null; emailVerified: boolean };

/**
 * The login email as pages and the CRM see it: only a verified real address.
 * Null for the placeholder (never shown or mailed) and for an unverified real
 * address, which an OAuth provider can supply for an account admitted through
 * its Telegram identity. Distinct from the self-declared contact email on the
 * profile, which is never derived from this.
 */
export function verifiedLoginEmail(user: Pick<StoredAccount, "email" | "emailVerified">): string | null {
  return user.email && user.emailVerified && !isPlaceholderEmail(user.email) ? user.email : null;
}

/**
 * What "verified account" means for HQ, defined once: a verified real email,
 * or a Telegram identity row. A session alone is not enough, and a
 * placeholder user whose identity row is missing fails closed. Every reader
 * of the member session (`currentMember()`, the account-creation hook and
 * whatever those serve) goes through this; nothing re-derives the rule.
 */
export async function isVerifiedAccount(user: StoredAccount): Promise<boolean> {
  if (verifiedLoginEmail(user) !== null) return true;
  return hasTelegramIdentity(user.id);
}

export type LoginMethods = {
  /** The stored login address; null when it is the internal placeholder, so it is never shown or mailed. */
  email: { address: string; verified: boolean } | null;
  telegram: TelegramIdentity | null;
  /** The optional, self-declared contact address on the profile. Never a login identity. */
  contactEmail: string | null;
};

/** Every way this account can sign in, plus its contact address. Adding or removing one never changes the account id. */
export async function getLoginMethods(userId: string): Promise<LoginMethods> {
  const [{ rows: users }, telegram, profile] = await Promise.all([
    builderDatabase().query(`SELECT email, "emailVerified" AS verified FROM hq_auth_user WHERE id = $1`, [userId]),
    getTelegramIdentity(userId),
    builderStore().profile(userId),
  ]);
  const address = users.length && typeof users[0].email === "string" ? users[0].email : null;
  return {
    email: address && !isPlaceholderEmail(address) ? { address, verified: Boolean(users[0].verified) } : null,
    telegram,
    contactEmail: profile?.contactEmail ?? null,
  };
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

/** Idempotent: a repeat login refreshes the snapshot and last_login_at only. Writes through `db` so a caller's transaction can carry the audit event too. */
export async function upsertTelegramIdentity(input: TelegramIdentityInput, db: BuilderQuery = builderDatabase()): Promise<void> {
  await db.query(
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

/** True when a row was removed; false when the account had no identity row to begin with. */
export async function deleteTelegramIdentity(userId: string, db: BuilderQuery = builderDatabase()): Promise<boolean> {
  const { rows } = await db.query(`DELETE FROM hq_auth_telegram_identity WHERE user_id = $1 RETURNING user_id`, [userId]);
  return rows.length > 0;
}
