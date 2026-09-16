import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { customSession, emailOTP } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { Pool } from "pg";
import { Resend } from "resend";
import { getMemberAuthAvailability, memberAuthOrigin, memberAuthUsesSecureCookies, safeMemberNext } from "./member-auth-config";
import { recordAuditEvent } from "./audit";
import { builderDatabase } from "./builder-db";
import { syncBuilderAccount } from "./builder-store";
import { isVerifiedAccount, verifiedLoginEmail } from "./identity";
import { memberEmailDeliveryFailed } from "./member-auth-delivery";
import { memberCodeEmail } from "./member-email";
import { memberEmailLogo } from "./member-email-logo";
import { hqTelegramIdentity } from "./telegram-identity-plugin";
import { isPlaceholderEmail } from "./telegram-provider";

/** `email` is null for accounts whose stored address is the internal placeholder (Telegram-only). */
export type MemberSessionUser = { id: string; email: string | null; name: string };

export class MemberAuthUnavailableError extends Error {
  constructor() {
    super("Account sign-in is not available yet. Please try again later.");
    this.name = "MemberAuthUnavailableError";
  }
}

// The verified-account rule and the login email it yields live in
// ./identity (`isVerifiedAccount`, `verifiedLoginEmail`). The session reader
// below and the account-creation hook both import them; neither restates the
// rule. The placeholder checks that remain here guard endpoints, not access.

/** Every message has a plain-text fallback; verification codes also carry HTML. */
type MemberEmail = { to: string; subject: string; text: string; html?: string };

/**
 * The library's answers on /email-otp/change-email that only a stored code
 * can produce. The request route stores a code for a free address and none
 * for an address another account holds, so these would tell a caller, after
 * a few guesses, which addresses have HQ accounts (task T2.5 review).
 */
const CHANGE_EMAIL_CODE_TELLS: ReadonlySet<string> = new Set(["TOO_MANY_ATTEMPTS", "OTP_EXPIRED"]);

/** The one code type the public code endpoint serves: HQ has no password to reset and no separate email-verification step. */
const PUBLIC_OTP_TYPE = "sign-in";

function createMemberAuth() {
  const available = getMemberAuthAvailability();
  const baseURL = memberAuthOrigin();
  if (!available.configured || !baseURL) throw new MemberAuthUnavailableError();
  // Prefix and attribute follow the origin's scheme together, never NODE_ENV.
  const secureCookies = memberAuthUsesSecureCookies();

  /**
   * The one way member email leaves this module. False when nothing was
   * sent: the address is a placeholder (the last line of defence; the
   * identity plugin refuses those before any row exists), email is not
   * configured, or Resend reported a failure. Never throws.
   */
  async function deliver(message: MemberEmail): Promise<boolean> {
    if (isPlaceholderEmail(message.to) || !available.email) return false;
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const attachments = message.html ? [await memberEmailLogo()] : undefined;
      const { error } = await resend.emails.send({ from: process.env.EMAIL_FROM!, ...message, ...(attachments ? { attachments } : {}) });
      return !error;
    } catch {
      return false;
    }
  }

  return betterAuth({
    appName: "Superteam NL HQ",
    baseURL,
    secret: process.env.BETTER_AUTH_SECRET,
    trustedOrigins: [baseURL],
    database: new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: true,
    }),
    user: {
      modelName: "hq_auth_user",
      // A placeholder address may only ever come from an OAuth identity without an email.
      validateUserInfo: ({ user, source }) =>
        source.method !== "oauth" && isPlaceholderEmail(typeof user.email === "string" ? user.email : undefined)
          ? { error: "placeholder_email_not_allowed", errorDescription: "This address cannot be used to sign in." }
          : undefined,
    },
    session: {
      modelName: "hq_auth_session",
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    account: {
      modelName: "hq_auth_account",
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        // Telegram reports no verified email; linking is explicit and session-bound only.
        trustedProviders: ["telegram"],
        allowDifferentEmails: true,
        disableImplicitLinking: true,
        // The core's last-account rule counts account rows, and an email-OTP
        // user has none, so it would refuse every unlink. The identity plugin
        // enforces the real rule: Telegram goes only if a verified email remains.
        allowUnlinkingAll: true,
      },
    },
    verification: { modelName: "hq_auth_verification" },
    // A disabled path answers 404 before the rate limiter and every hook
    // (api/index.mjs onRequest). The first three would hand the session
    // holder the stored provider tokens, including the Telegram id_token;
    // nothing in HQ needs them and the stored id_token is read only by the
    // identity plugin's database hooks. The email-OTP ones serve flows HQ
    // does not have: password reset (three paths) and a separate
    // email-verification code. check-verification-otp also tests a sign-in
    // code without consuming it and counts attempts non-atomically
    // (plugins/email-otp/routes.mjs), a second guesser next to the atomic one.
    disabledPaths: [
      "/get-access-token",
      "/refresh-token",
      "/account-info",
      "/email-otp/check-verification-otp",
      "/email-otp/verify-email",
      "/email-otp/request-password-reset",
      "/forget-password/email-otp",
      "/email-otp/reset-password",
    ],
    advanced: {
      cookiePrefix: "stnl_builder",
      disableOriginCheck: false,
      disableCSRFCheck: false,
      // Vercel sets x-real-ip from the connection and overwrites a client's
      // own value (vercel.com/docs/headers/request-headers); the library
      // reads no other header, takes only a single valid address and shares
      // one bucket per path among requests without it (core utils/ip.mjs,
      // api/rate-limiter/index.mjs). Behind any other proxy, add its
      // trustedProxies before relying on these limits.
      ipAddress: { ipAddressHeaders: ["x-real-ip"] },
      useSecureCookies: secureCookies,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: secureCookies },
    },
    // No `socialProviders` option: the only OAuth provider is Telegram, which
    // the hqTelegramIdentity plugin registers on the context in its init.

    // Per client address and path, decided before any handler runs. A custom
    // rule replaces the plugin's, which replaces the library's default
    // special rule (api/rate-limiter/index.mjs resolveRateLimitConfig):
    // the sign-in code endpoint allows a mistyped code and a resend within
    // the minute, while the code's own three-attempt budget bounds guessing.
    // Everything not named here (the change-email pair at 3 per minute from
    // the emailOTP plugin, the Telegram callback at 10 from the identity
    // plugin, /sign-in/social at 3 per 10 seconds from the library) is
    // reviewed in docs/hq/implementation-log.md, task T2.5.
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "hq_auth_rate_limit",
      window: 60,
      max: 60,
      customRules: {
        "/email-otp/send-verification-otp": { window: 60, max: 3 },
        "/sign-in/email-otp": { window: 60, max: 5 },
      },
    },
    hooks: {
      /**
       * The public code endpoint takes three code types and HQ uses one.
       * For the other two the library mails a known address and answers an
       * unknown one at once, without a mail (plugins/email-otp/routes.mjs
       * sendVerificationOTP), so they would tell a caller which addresses
       * have accounts and let anyone mail a member a code. A sign-in code
       * goes to every address alike.
       */
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/email-otp/send-verification-otp" && ctx.body?.type !== PUBLIC_OTP_TYPE) {
          throw new APIError("BAD_REQUEST", { code: "INVALID_OTP_TYPE", message: "Only a sign-in code can be requested." });
        }
      }),
      /**
       * Every failed code on /email-otp/change-email answers 400 INVALID_OTP,
       * the answer an address with no stored code gets. A Response is
       * returned rather than an error thrown: the dispatcher keeps the
       * handler's status for an error from an after hook and replaces it
       * only with a Response (api/dispatch.mjs, better-call to-response.mjs).
       */
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/email-otp/change-email") return;
        const returned: unknown = ctx.context.returned;
        if (!isAPIError(returned) || !CHANGE_EMAIL_CODE_TELLS.has(String(returned.body?.code))) return;
        const invalid = new APIError("BAD_REQUEST", { code: "INVALID_OTP", message: "Invalid OTP" });
        return new Response(JSON.stringify(invalid.body), {
          status: invalid.statusCode,
          statusText: String(invalid.status),
          headers: { "Content-Type": "application/json" },
        });
      }),
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            if (!user.name.trim() || !(await isVerifiedAccount(user))) return;
            await syncBuilderAccount({ id: user.id, email: verifiedLoginEmail(user), name: user.name.trim() });
          },
        },
        update: {
          /**
           * The login email changed. Only /email-otp/change-email does that,
           * and it updates the session's own user, so the session on the
           * endpoint context still carries the previous address (the cookie
           * is refreshed after updateUser returns). When that address was a
           * verified real one, it is told; a Telegram-first account had only
           * the placeholder, and nothing is ever sent to that. The audit
           * event records which case it was and nothing else. Post-commit:
           * a failure here is logged, never surfaced as a failed change.
           */
          after: async (user, context) => {
            // updateWithHooks hands null when the update matched no row.
            if (!user) return;
            const previous = context?.context.session?.user;
            if (!previous || previous.id !== user.id || typeof user.email !== "string" || user.email === previous.email) return;
            const previousEmail = verifiedLoginEmail(previous);
            try {
              if (previousEmail !== null) {
                // The notice names no new address: whoever still reads the
                // old mailbox (the usual reason to move) must not learn the
                // account's new login identifier.
                const delivered = await deliver({
                  to: previousEmail,
                  subject: "Your Superteam NL HQ sign-in email changed",
                  text: "The email address for signing in to your Superteam NL HQ account was changed, and this address no longer signs in to it.\n\nIf this was you, there is nothing to do. If it was not, contact Superteam NL right away.",
                });
                if (!delivered) context.context.logger.error("hq-member-auth: the previous address was not notified of the email change", { userId: user.id });
              }
              await recordAuditEvent(builderDatabase(), { kind: "identity.email_changed", actor: { kind: "member", id: user.id }, subjectUserId: user.id, metadata: { hadPreviousEmail: previousEmail !== null } });
              if (user.name.trim() && (await isVerifiedAccount(user))) await syncBuilderAccount({ id: user.id, email: verifiedLoginEmail(user), name: user.name.trim() });
            } catch (error) {
              context.context.logger.error("hq-member-auth: email change follow-up failed", error);
            }
          },
        },
      },
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 15 * 60,
        allowedAttempts: 3,
        storeOTP: "hashed",
        // The recovery-email flow for Telegram-first accounts, and the only
        // way a login email changes: the code goes to the new address alone.
        // The current address is never asked for a code, so a placeholder
        // there is never mailed (routes.mjs sends only to newEmail).
        changeEmail: { enabled: true, verifyCurrentEmail: false },
        async sendVerificationOTP({ email, otp, type }) {
          const message = memberCodeEmail({ otp, type });
          // Better Auth absorbs sender errors; the delivery module turns
          // this flag into an honest 503 for the request.
          if (!(await deliver({ to: email, ...message }))) memberEmailDeliveryFailed();
        },
      }),
      hqTelegramIdentity({
        provider: available.telegram
          ? { clientId: process.env.TELEGRAM_LOGIN_CLIENT_ID!, clientSecret: process.env.TELEGRAM_LOGIN_CLIENT_SECRET! }
          : null,
      }),
      // /get-session hands the stored hq_auth_user row to whoever holds the
      // cookie, so a Telegram-only account's own browser would otherwise be
      // told its internal placeholder address. This plugin replaces that
      // endpoint, and with it api.getSession(), so every reader of a member
      // session sees null instead: the invariant holds in the code rather
      // than depending on each caller remembering it. Disabling the path
      // instead would 404 the library's own session endpoint, which the auth
      // client refetches after a sign-in or a link.
      customSession(async ({ user, session }) => {
        const placeholder = isPlaceholderEmail(user.email);
        return { session, user: { ...user, email: placeholder ? null : user.email, emailVerified: placeholder ? false : user.emailVerified } };
      }),
      nextCookies(),
    ],
  });
}

let instance: ReturnType<typeof createMemberAuth> | undefined;

/** Lazy configuration lets unrelated public pages build without auth secrets. */
export function getAuth() {
  instance ??= createMemberAuth();
  return instance;
}

/**
 * The raw Better Auth session behind the member cookie, before the
 * verified-account rule. Only the identity actions read it, for the session's
 * creation time and the stored login fields; every access decision goes
 * through `currentMember()`. Null when public sign-in is not configured.
 */
export const currentMemberSession = cache(async () => {
  if (!getMemberAuthAvailability().configured) return null;
  return getAuth().api.getSession({ headers: await headers() });
});

export const currentMember = cache(async (): Promise<MemberSessionUser | null> => {
  const session = await currentMemberSession();
  if (!session || !(await isVerifiedAccount(session.user))) return null;
  const user = { id: session.user.id, email: verifiedLoginEmail(session.user), name: session.user.name };
  // Also repairs an interrupted CRM sync without duplicating People entries.
  // A Telegram-only account syncs like any other, with no email.
  if (user.name.trim()) await syncBuilderAccount({ id: user.id, email: user.email, name: user.name.trim() });
  return user;
});

/**
 * Sends a visitor without a usable member session to sign in. Call only
 * after `currentMember()` returned null. A session that still exists at that
 * point failed the verified-account rule: a Telegram-only account whose
 * identity row never landed (the plugin writes it after commit). Such a
 * session is ended here, so the cookie cannot keep bouncing, and the sign-in
 * page is told why. The cookie itself cannot be cleared from a render; a
 * cookie without a session row is simply not a session.
 */
export async function redirectToMemberSignIn(next: string): Promise<never> {
  const destination = safeMemberNext(next);
  const session = await currentMemberSession();
  if (session) {
    await (await getAuth().$context).internalAdapter.deleteSession(session.session.token);
    redirect(`/hq/login?error=identity_missing&next=${encodeURIComponent(destination)}`);
  }
  redirect(`/hq/login?next=${encodeURIComponent(destination)}`);
}

export async function requireMember(next = "/hq/welcome"): Promise<MemberSessionUser> {
  const destination = safeMemberNext(next);
  const user = await currentMember();
  if (!user) return redirectToMemberSignIn(destination);
  if (!user.name.trim()) redirect(`/hq/profile?next=${encodeURIComponent(destination)}`);
  return user;
}
