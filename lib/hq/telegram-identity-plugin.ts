import "server-only";
import type { GenericEndpointContext } from "@better-auth/core";
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { recordAuditEvent } from "./audit";
import { builderDatabase } from "./builder-db";
import {
  deleteTelegramIdentity,
  findTelegramIdentityConflict,
  hasTelegramIdentity,
  upsertTelegramIdentity,
  verifiedLoginEmail,
  type StoredAccount,
  type TelegramIdentityInput,
} from "./identity";
import { revokeBotConsent } from "./telegram-consent";
import { isPlaceholderEmail, readTelegramClaims, TELEGRAM_PROVIDER_ID, telegramProvider, type TelegramProviderEnv } from "./telegram-provider";

/**
 * How recently a session must have been created for link, unlink and
 * change-email. Better Auth keeps no re-authentication time: a session row
 * carries `createdAt` (set once, at sign-in) and `updatedAt` (touched by the
 * `updateAge` refresh), and its own freshSessionMiddleware compares
 * `createdAt` too (api/routes/session.mjs). So "recent" means signed in
 * within this window, and the only way to become recent again is to sign in.
 */
export const RECENT_SESSION_MS = 15 * 60 * 1000;

/** How long a confirmed link or unlink stays usable before the member has to confirm again. */
const TELEGRAM_INTENT_MS = 10 * 60 * 1000;

/**
 * Endpoints that take an address from the body and would mail it, look it
 * up, verify it or write a verification row for it. A placeholder address
 * (see telegram-provider.ts) must be refused before any of that happens.
 * Hook contexts carry the route template, so these are exact paths.
 */
export const PLACEHOLDER_GUARDED_ENDPOINTS: ReadonlySet<string> = new Set([
  "/email-otp/send-verification-otp",
  "/email-otp/check-verification-otp",
  "/email-otp/verify-email",
  "/sign-in/email-otp",
  "/email-otp/request-password-reset",
  "/forget-password/email-otp",
  "/email-otp/reset-password",
  "/email-otp/request-email-change",
  "/email-otp/change-email",
  "/change-email",
  "/send-verification-email",
  "/request-password-reset",
  "/verify-email",
]);

/** Endpoints with a client id_token branch. Only the redirect flow with a server nonce exists here. */
export const ID_TOKEN_ENDPOINTS: ReadonlySet<string> = new Set(["/sign-in/social", "/link-social"]);

/**
 * Endpoints that add or remove a way to sign in. Adding one is as sensitive
 * as removing one (a recovery email later satisfies the unlink rule), so all
 * of them sit behind the same recency window. The core `/change-email` stays
 * disabled (`user.changeEmail` is unset); it is listed so that enabling it
 * one day cannot open a path around the window or the placeholder guard.
 */
export const RECENT_SESSION_ENDPOINTS: ReadonlySet<string> = new Set([
  "/link-social",
  "/unlink-account",
  "/email-otp/request-email-change",
  "/email-otp/change-email",
  "/change-email",
]);

type DatabaseHooks = NonNullable<BetterAuthOptions["databaseHooks"]>;
type AccountRow = { providerId?: string | null; userId?: string | null; accountId?: string | null; idToken?: string | null };
type Logger = { error: (message: string, ...args: unknown[]) => void; warn: (message: string, ...args: unknown[]) => void };
type InternalAdapter = GenericEndpointContext["context"]["internalAdapter"];
/** The slice of Better Auth's internal adapter the confirmation intent needs. */
type TelegramIntentStore = Pick<InternalAdapter, "createVerificationValue" | "deleteVerificationByIdentifier" | "consumeVerificationValue">;
/** The three confirmed changes to the ways of signing in; `change-email` is bound to the address it was confirmed for. */
type TelegramIntent = "link" | "unlink" | "change-email";

const isTelegram = (account: AccountRow | null | undefined): account is AccountRow & { userId: string } =>
  Boolean(account && account.providerId === TELEGRAM_PROVIDER_ID && typeof account.userId === "string");

/** The one recency rule: the session was created less than RECENT_SESSION_MS ago. */
export function isRecentSession(session: { createdAt: Date | string }, now = Date.now()): boolean {
  return now - new Date(session.createdAt).getTime() < RECENT_SESSION_MS;
}

/**
 * The one last-login-method rule. The core's own check counts account rows,
 * which is useless here: an email-OTP user has no account row at all, so it
 * would either refuse every unlink or, with `allowUnlinkingAll`, allow one
 * that leaves the person with no way in. What keeps an account reachable
 * after Telegram goes is a verified real email, and nothing else.
 */
export function telegramIsLastLoginMethod(user: Pick<StoredAccount, "email" | "emailVerified">): boolean {
  return verifiedLoginEmail(user) === null;
}

const intentIdentifier = (userId: string) => `hq-telegram-intent:${userId}`;

/** The stored form of an intent: the action, and for change-email the address it was confirmed for. */
const intentValue = (intent: TelegramIntent, subject?: string) => (subject === undefined ? intent : `${intent}:${subject}`);

/**
 * The one spelling of an address on its way to the change-email endpoints,
 * used by the confirmation action when it records the intent and by the hook
 * when it compares the request against it. The library lowercases too; the
 * trim is ours, so that a pasted address with a stray space still matches.
 * Non-strings become the empty string, which never matches anything.
 */
export function normalizeEmailAddress(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Records that the member confirmed a link, an unlink or a change of email
 * on the account page. Stored as a single-use `hq_auth_verification` row
 * keyed by user id, so a `/link-social`, `/unlink-account` or
 * `/email-otp/request-email-change` request that did not come through the
 * confirmation step finds nothing and is refused. One intent per user: a
 * new confirmation replaces the previous one. A change-email intent carries
 * the confirmed address, so the endpoint cannot be pointed at another one.
 */
export async function recordTelegramIntent(store: TelegramIntentStore, userId: string, intent: TelegramIntent, subject?: string): Promise<void> {
  await store.deleteVerificationByIdentifier(intentIdentifier(userId));
  await store.createVerificationValue({ identifier: intentIdentifier(userId), value: intentValue(intent, subject), expiresAt: new Date(Date.now() + TELEGRAM_INTENT_MS) });
}

/** Consumes the recorded confirmation. False when there is none, it expired, or it was for another action or address; the row is gone either way. */
async function consumeTelegramIntent(store: TelegramIntentStore, userId: string, intent: TelegramIntent, subject?: string): Promise<boolean> {
  const row = await store.consumeVerificationValue(intentIdentifier(userId));
  return row?.value === intentValue(intent, subject);
}

/**
 * The identity carried by a telegram account row. The raw id_token on the row
 * was verified by getUserInfo moments earlier (it is the only writer of
 * telegram accounts); the subject is cross-checked against the account key.
 * Null when the token is missing, undecodable, or lacks the numeric id.
 * Assumes the id_token is stored as-is: under encryptOAuthTokens the core's
 * setTokenUtil encrypts only access and refresh tokens (link-account.mjs).
 * This is the only place the stored id_token is read.
 */
function identityFromAccount(account: AccountRow & { userId: string }): TelegramIdentityInput | null {
  const claims = account.idToken ? readTelegramClaims(account.idToken) : null;
  if (!claims || claims.id === undefined || claims.sub !== account.accountId) return null;
  return {
    userId: account.userId,
    telegramUserId: String(claims.id),
    providerSubject: claims.sub,
    username: claims.preferred_username ?? null,
    photoUrl: claims.picture ?? null,
  };
}

const placeholderRefused = () =>
  new APIError("BAD_REQUEST", { code: "placeholder_email_not_allowed", message: "This address cannot receive email. Use your own email address." });
const sessionNotFresh = () => new APIError("FORBIDDEN", { code: "SESSION_NOT_FRESH", message: "Please sign in again to continue." });
const notConfirmed = () => new APIError("FORBIDDEN", { code: "CONFIRMATION_REQUIRED", message: "Confirm this change on your account page first." });

/** Audit metadata for an identity event: the provider and nothing else, never a token, a subject or a Telegram id. */
const identityAuditMetadata = { provider: TELEGRAM_PROVIDER_ID } as const;

function databaseHooks(): DatabaseHooks {
  const log = (context: { context: { logger: Logger } } | null | undefined): Logger => context?.context.logger ?? console;

  /**
   * Post-commit and idempotent: the account (and on first login the user)
   * already exist, so an error here is logged, never thrown. A missing row
   * leaves currentMember() failing closed until the next login repairs it;
   * redirectToMemberSignIn() ends such a session and says why.
   * The identity row and, on a new account, the `identity.linked` audit
   * event are one transaction on the builder pool.
   */
  const persist = async (account: AccountRow | null, context: GenericEndpointContext | null, created: boolean) => {
    if (!isTelegram(account)) return;
    const identity = identityFromAccount(account);
    if (!identity) {
      log(context).warn("hq-telegram-identity: account carries no usable id_token; identity row not written", { userId: account.userId });
      return;
    }
    try {
      await builderDatabase().transaction(async (db) => {
        await upsertTelegramIdentity(identity, db);
        if (created) {
          await recordAuditEvent(db, { kind: "identity.linked", actor: { kind: "member", id: identity.userId }, subjectUserId: identity.userId, metadata: identityAuditMetadata });
        }
      });
    } catch (error) {
      log(context).error("hq-telegram-identity: identity upsert failed", error);
    }
  };

  return {
    account: {
      create: {
        /**
         * Runs inside the Better Auth transaction that creates the user and
         * the account, so a throw here unwinds both: no orphan placeholder
         * user, no account, no session. Returning false would NOT abort the
         * sign-in path (the library would still create a session), hence
         * always throw. The identity row itself is written after commit,
         * because this pool is a different connection and could not see the
         * uncommitted user the row references.
         */
        before: async (account, context) => {
          if (!isTelegram(account)) return;
          const identity = identityFromAccount(account);
          if (!identity) {
            log(context).warn("hq-telegram-identity: incomplete identity");
            throw new APIError("BAD_REQUEST", { code: "telegram_identity_incomplete", message: "Telegram did not return a usable identity. Try again." });
          }
          const holder = await findTelegramIdentityConflict(identity);
          if (holder) {
            throw new APIError("CONFLICT", { code: "telegram_identity_conflict", message: "This Telegram account is already connected to another HQ account. Sign in to that account instead." });
          }
          // One Telegram per HQ account: the identity row is keyed on user_id,
          // so a second telegram account row would silently move it. The
          // /link-social hook refuses this first; this is the in-transaction backstop.
          if (await hasTelegramIdentity(identity.userId)) {
            throw new APIError("CONFLICT", { code: "telegram_already_connected", message: "This HQ account already has a Telegram connection." });
          }
        },
        after: (account, context) => persist(account, context, true),
      },
      update: {
        // A repeat login refreshes the stored id_token, so this fires on every Telegram sign-in.
        after: (account, context) => persist(account, context, false),
      },
      delete: {
        /**
         * deleteWithHooks hands the fetched row (providerId, userId) to this
         * hook, and internalAdapter.deleteAccount is what /unlink-account
         * calls (db/with-hooks.mjs, db/internal-adapter.mjs). The audit event
         * is written only when a row was actually removed. Bot-messaging
         * consent goes in the same transaction: with the identity gone there
         * is nobody to message, whether or not the identity row was there.
         */
        after: async (account, context) => {
          if (!isTelegram(account)) return;
          try {
            await builderDatabase().transaction(async (db) => {
              if (await deleteTelegramIdentity(account.userId, db)) {
                await recordAuditEvent(db, { kind: "identity.unlinked", actor: { kind: "member", id: account.userId }, subjectUserId: account.userId, metadata: identityAuditMetadata });
              }
              await revokeBotConsent(account.userId, db);
            });
          } catch (error) {
            log(context).error("hq-telegram-identity: identity delete failed", error);
          }
        },
      },
    },
    user: {
      update: {
        /**
         * updateUser never runs validateUserInfo, so this is what stops a
         * placeholder from being written as an email. The one place it may
         * be is the Telegram callback (route template `/callback/:id` with
         * `params.id` telegram, never another provider), and there only as
         * a rewrite of a placeholder the user already has: the core's
         * `overrideUserInfoOnSignIn` path (oauth2/link-account.mjs) writes
         * the provider's email back on every sign-in, which for a linked
         * account would replace its real address. The hook sees no user id,
         * but email is unique, so a user holding exactly this placeholder
         * is the only user the update can land on without violating it.
         * The change-email routes can never set one.
         */
        before: async (user, context) => {
          const email = typeof user.email === "string" ? user.email : undefined;
          if (!isPlaceholderEmail(email)) return;
          const telegramCallback = context?.path === "/callback/:id" && context.params?.id === TELEGRAM_PROVIDER_ID;
          if (!telegramCallback || !(await context.context.internalAdapter.findUserByEmail(email!))) throw placeholderRefused();
        },
      },
    },
  };
}

type HqTelegramIdentityOptions = {
  /** Client credentials from BotFather; null keeps every guard active but registers no provider. */
  provider: TelegramProviderEnv | null;
};

/**
 * Registers the static Telegram provider (no I/O at init) and owns everything
 * the placeholder-email model needs: the identity table hooks, the
 * placeholder guards, the second fence over the client id_token branches,
 * and the rules for adding or removing a login method (recent session,
 * confirmed intent, one Telegram per account, never the last method).
 */
export function hqTelegramIdentity(opts: HqTelegramIdentityOptions = { provider: null }): BetterAuthPlugin {
  return {
    id: "hq-telegram-identity",
    init(ctx) {
      // Rejection diagnostics go through Better Auth's logger unless the
      // caller injected a sink; the default logger publishes `warn` and up.
      const provider = opts.provider ? telegramProvider({ ...opts.provider, warn: opts.provider.warn ?? ((message) => ctx.logger.warn(message)) }) : null;
      const socialProviders = provider ? [provider, ...ctx.socialProviders] : ctx.socialProviders;
      return { context: { socialProviders }, options: { databaseHooks: databaseHooks() } };
    },
    hooks: {
      before: [
        {
          matcher: (context) => PLACEHOLDER_GUARDED_ENDPOINTS.has(context.path ?? ""),
          handler: createAuthMiddleware(async (context) => {
            const email: unknown = context.body?.email ?? context.body?.newEmail;
            if (isPlaceholderEmail(typeof email === "string" ? email : undefined)) throw placeholderRefused();
          }),
        },
        {
          matcher: (context) => ID_TOKEN_ENDPOINTS.has(context.path ?? ""),
          handler: createAuthMiddleware(async (context) => {
            if (context.body?.idToken !== undefined) {
              throw new APIError("BAD_REQUEST", { code: "id_token_not_accepted", message: "Sign in with Telegram through the redirect flow." });
            }
          }),
        },
        {
          matcher: (context) => RECENT_SESSION_ENDPOINTS.has(context.path ?? ""),
          handler: createAuthMiddleware(async (context) => {
            // Fail closed: the endpoints' own session middlewares run after
            // this hook, so it does not lean on them.
            const session = await getSessionFromCtx(context);
            if (!session) throw new APIError("UNAUTHORIZED", { code: "UNAUTHORIZED", message: "Sign in to continue." });
            if (!isRecentSession(session.session)) throw sessionNotFresh();
            const store = context.context.internalAdapter;
            if (context.path === "/link-social" && context.body?.provider === TELEGRAM_PROVIDER_ID) {
              if (await hasTelegramIdentity(session.user.id)) {
                throw new APIError("CONFLICT", { code: "TELEGRAM_ALREADY_CONNECTED", message: "This account already has a Telegram connection." });
              }
              if (!(await consumeTelegramIntent(store, session.user.id, "link"))) throw notConfirmed();
            }
            // The confirmation names the address; a request for any other
            // address, or without one, is not the confirmed change. The OTP
            // that /email-otp/change-email then needs exists only for a
            // request that passed here, so the intent is consumed once.
            if (context.path === "/email-otp/request-email-change") {
              if (!(await consumeTelegramIntent(store, session.user.id, "change-email", normalizeEmailAddress(context.body?.newEmail)))) throw notConfirmed();
            }
            if (context.path === "/unlink-account") {
              const accounts = await store.findAccounts(session.user.id);
              const target = accounts.find((account) => account.id === context.body?.accountId);
              if (target?.providerId !== TELEGRAM_PROVIDER_ID) return;
              if (telegramIsLastLoginMethod(session.user)) {
                throw new APIError("BAD_REQUEST", { code: "LAST_LOGIN_METHOD", message: "Telegram is the only way to sign in to this account. Add a verified email before disconnecting it." });
              }
              if (!(await consumeTelegramIntent(store, session.user.id, "unlink"))) throw notConfirmed();
            }
          }),
        },
      ],
    },
    // pathMatcher receives the normalized request path, unlike hook contexts.
    rateLimit: [{ pathMatcher: (path) => path === `/callback/${TELEGRAM_PROVIDER_ID}`, window: 60, max: 10 }],
  };
}
