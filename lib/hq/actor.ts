import "server-only";
import { builderDatabase, type BuilderQuery } from "./builder-db";
import { listActiveCapabilities, type Capability } from "./capabilities";
import { findTelegramIdentityByTelegramUserId, getTelegramIdentity, verifiedLoginEmail } from "./identity";
import { requireMember, type MemberSessionUser } from "./member-auth";

/**
 * Authenticated service actors keep operator and member sessions separate.
 * Public accounts never become operators through capabilities. Actor ids come
 * only from validated sessions or verified Telegram identities; job actors
 * carry their authenticated audience. Never construct actors from request fields.
 */
export type Actor =
  | { kind: "operator"; id: string; displayName: string }
  | {
      kind: "member";
      id: string;
      name: string;
      email: string | null;
      /** Presentation snapshot only; authorization reads current grants again. */
      capabilities: ReadonlySet<Capability>;
      /** The linked Telegram identity; `userId` is a string at every boundary. */
      telegram: { userId: string } | null;
    }
  | { kind: "job"; audience: string };
export type MemberActor = Extract<Actor, { kind: "member" }>;

async function memberActor(user: MemberSessionUser): Promise<MemberActor> {
  const [capabilities, telegram] = await Promise.all([listActiveCapabilities(user.id), getTelegramIdentity(user.id)]);
  return {
    kind: "member",
    id: user.id,
    name: user.name,
    email: user.email,
    capabilities: new Set(capabilities),
    telegram: telegram ? { userId: telegram.telegramUserId } : null,
  };
}

/** The member gate: redirects like `requireMember()`, then builds the member actor. */
export async function requireMemberActor(next?: string): Promise<MemberActor> {
  return memberActor(await requireMember(next));
}

/**
 * Resolve a verified Telegram identity fresh for each bot update, so unlinking
 * revokes access immediately. Unknown identities or removed accounts return null.
 * Use the same capabilities and verified-email rules as session actors; every
 * bot operation must still authorize its project action.
 */
export async function telegramMemberActor(telegramUserId: string, db: BuilderQuery = builderDatabase()): Promise<MemberActor | null> {
  const identity = await findTelegramIdentityByTelegramUserId(telegramUserId, db);
  if (!identity) return null;
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email, u."emailVerified" AS verified
     FROM hq_auth_user u JOIN hq_builder_profiles b ON b.id = u.id WHERE u.id = $1`,
    [identity.userId],
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    kind: "member",
    id: String(row.id),
    name: String(row.name ?? ""),
    email: verifiedLoginEmail({ email: row.email == null ? null : String(row.email), emailVerified: Boolean(row.verified) }),
    capabilities: new Set(await listActiveCapabilities(String(row.id), db)),
    telegram: { userId: identity.telegramUserId },
  };
}
