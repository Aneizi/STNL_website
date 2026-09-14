import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { Pool } from "pg";
import { Resend } from "resend";
import { getMemberAuthAvailability, memberAuthOrigin, safeMemberNext } from "./member-auth-config";
import { recordAuditEvent } from "./audit";
import { builderDatabase } from "./builder-db";
import { syncBuilderAccount } from "./builder-store";
import { isVerifiedAccount, verifiedLoginEmail } from "./identity";
import { memberEmailDeliveryFailed } from "./member-auth-delivery";
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

/** What the one sender takes: a plain message to one address. */
type MemberEmail = { to: string; subject: string; text: string };

function createMemberAuth() {
  const available = getMemberAuthAvailability();
  const baseURL = memberAuthOrigin();
  if (!available.configured || !baseURL) throw new MemberAuthUnavailableError();

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
      const { error } = await resend.emails.send({ from: process.env.EMAIL_FROM!, ...message });
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
    // These would hand the session holder the stored provider tokens,
    // including the Telegram id_token. Nothing in HQ needs them and the
    // stored id_token is read only by the identity plugin's database hooks.
    disabledPaths: ["/get-access-token", "/refresh-token", "/account-info"],
    advanced: {
      cookiePrefix: "stnl_builder",
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress: { ipAddressHeaders: ["x-real-ip"] },
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" },
    },
    // No `socialProviders` option: the only OAuth provider is Telegram, which
    // the hqTelegramIdentity plugin registers on the context in its init.
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "hq_auth_rate_limit",
      window: 60,
      max: 60,
      customRules: {
        "/email-otp/send-verification-otp": { window: 60, max: 3 },
        "/sign-in/email-otp": { window: 60, max: 5 },
        "/email-otp/verify-email": { window: 60, max: 5 },
      },
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
        expiresIn: 300,
        allowedAttempts: 3,
        storeOTP: "hashed",
        // The recovery-email flow for Telegram-first accounts, and the only
        // way a login email changes: the code goes to the new address alone.
        // The current address is never asked for a code, so a placeholder
        // there is never mailed (routes.mjs sends only to newEmail).
        changeEmail: { enabled: true, verifyCurrentEmail: false },
        async sendVerificationOTP({ email, otp, type }) {
          const message = type === "change-email"
            ? {
                subject: "Confirm your Superteam NL HQ email",
                text: `Your Superteam NL HQ code is ${otp}.\n\nEnter it to confirm this address for your HQ account. It expires in 5 minutes. If you did not ask to add this address, you can ignore this email.`,
              }
            : {
                subject: "Your Superteam NL HQ sign-in code",
                text: `Your Superteam NL HQ code is ${otp}.\n\nIt expires in 5 minutes. If you did not request this code, you can ignore this email.`,
              };
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
    redirect(`/hq/signin?error=identity_missing&next=${encodeURIComponent(destination)}`);
  }
  redirect(`/hq/signin?next=${encodeURIComponent(destination)}`);
}

export async function requireMember(next = "/hq/welcome"): Promise<MemberSessionUser> {
  const destination = safeMemberNext(next);
  const user = await currentMember();
  if (!user) return redirectToMemberSignIn(destination);
  if (!user.name.trim()) redirect(`/hq/profile?next=${encodeURIComponent(destination)}`);
  return user;
}
