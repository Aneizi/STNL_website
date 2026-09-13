import "server-only";
import type { GenericEndpointContext } from "@better-auth/core";
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { deleteTelegramIdentity, findTelegramIdentityConflict, upsertTelegramIdentity, type TelegramIdentityInput } from "./identity";
import { isPlaceholderEmail, readTelegramClaims, TELEGRAM_PROVIDER_ID, telegramProvider, type TelegramProviderEnv } from "./telegram-provider";

/** How recently a session must have been created for link, unlink and change-email (enforced in phase 2). */
export const RECENT_SESSION_MS = 15 * 60 * 1000;

/**
 * Endpoints that take an address from the body and would mail it, look it
 * up, verify it or write a verification row for it. A placeholder address
 * (see telegram-provider.ts) must be refused before any of that happens.
 * Hook contexts carry the route template, so these are exact paths.
 */
const EMAIL_ENDPOINTS = new Set([
  "/email-otp/send-verification-otp",
  "/email-otp/check-verification-otp",
  "/email-otp/verify-email",
  "/sign-in/email-otp",
  "/email-otp/request-password-reset",
  "/forget-password/email-otp",
  "/email-otp/reset-password",
  "/email-otp/request-email-change",
  "/email-otp/change-email",
  "/send-verification-email",
  "/request-password-reset",
  "/verify-email",
]);

/** Endpoints with a client id_token branch. Only the redirect flow with a server nonce exists here. */
const ID_TOKEN_ENDPOINTS = new Set(["/sign-in/social", "/link-social"]);

type DatabaseHooks = NonNullable<BetterAuthOptions["databaseHooks"]>;
type AccountRow = { providerId?: string | null; userId?: string | null; accountId?: string | null; idToken?: string | null };
type Logger = { error: (message: string, ...args: unknown[]) => void; warn: (message: string, ...args: unknown[]) => void };

const isTelegram = (account: AccountRow | null | undefined): account is AccountRow & { userId: string } =>
  Boolean(account && account.providerId === TELEGRAM_PROVIDER_ID && typeof account.userId === "string");

/**
 * The identity carried by a telegram account row. The raw id_token on the row
 * was verified by getUserInfo moments earlier (it is the only writer of
 * telegram accounts); the subject is cross-checked against the account key.
 * Null when the token is missing, undecodable, or lacks the numeric id.
 * Assumes the id_token is stored as-is: under encryptOAuthTokens the core's
 * setTokenUtil encrypts only access and refresh tokens (link-account.mjs).
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

function databaseHooks(): DatabaseHooks {
  const log = (context: { context: { logger: Logger } } | null | undefined): Logger => context?.context.logger ?? console;

  /**
   * Post-commit and idempotent: the account (and on first login the user)
   * already exist, so an error here is logged, never thrown. A missing row
   * leaves currentMember() failing closed until the next login repairs it.
   */
  const persist = async (account: AccountRow | null, context: GenericEndpointContext | null) => {
    if (!isTelegram(account)) return;
    const identity = identityFromAccount(account);
    if (!identity) {
      log(context).warn("hq-telegram-identity: account carries no usable id_token; identity row not written", { userId: account.userId });
      return;
    }
    try {
      await upsertTelegramIdentity(identity);
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
        before: async (account) => {
          if (!isTelegram(account)) return;
          const identity = identityFromAccount(account);
          if (!identity) {
            throw new APIError("BAD_REQUEST", { code: "telegram_identity_incomplete", message: "Telegram did not return a usable identity. Try again." });
          }
          const holder = await findTelegramIdentityConflict(identity);
          if (holder) {
            throw new APIError("CONFLICT", { code: "telegram_identity_conflict", message: "This Telegram account is already connected to another HQ account. Sign in to that account instead." });
          }
        },
        after: persist,
      },
      update: {
        // A repeat login refreshes the stored id_token, so this fires on every Telegram sign-in.
        after: persist,
      },
      delete: {
        after: async (account, context) => {
          if (!isTelegram(account)) return;
          try {
            await deleteTelegramIdentity(account.userId);
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
         * placeholder from being written as an email anywhere but on the
         * OAuth callback route (route template, not request path).
         */
        before: async (user, context) => {
          if (isPlaceholderEmail(typeof user.email === "string" ? user.email : undefined) && context?.path !== "/callback/:id") {
            throw placeholderRefused();
          }
        },
      },
    },
  };
}

export type HqTelegramIdentityOptions = {
  /** Client credentials from BotFather; null keeps every guard active but registers no provider. */
  provider: TelegramProviderEnv | null;
};

/**
 * Registers the static Telegram provider (no I/O at init) and owns everything
 * the placeholder-email model needs: the identity table hooks, the
 * placeholder guards and the second fence over the client id_token branches.
 */
export function hqTelegramIdentity(opts: HqTelegramIdentityOptions = { provider: null }): BetterAuthPlugin {
  return {
    id: "hq-telegram-identity",
    init(ctx) {
      const socialProviders = opts.provider ? [telegramProvider(opts.provider), ...ctx.socialProviders] : ctx.socialProviders;
      return { context: { socialProviders }, options: { databaseHooks: databaseHooks() } };
    },
    hooks: {
      before: [
        {
          matcher: (context) => EMAIL_ENDPOINTS.has(context.path ?? ""),
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
      ],
    },
    // pathMatcher receives the normalized request path, unlike hook contexts.
    rateLimit: [{ pathMatcher: (path) => path === `/callback/${TELEGRAM_PROVIDER_ID}`, window: 60, max: 10 }],
  };
}
