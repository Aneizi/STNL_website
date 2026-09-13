import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { Pool } from "pg";
import { Resend } from "resend";
import { getMemberAuthAvailability, memberAuthOrigin, safeMemberNext } from "./member-auth-config";
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

function createMemberAuth() {
  const available = getMemberAuthAvailability();
  const baseURL = memberAuthOrigin();
  if (!available.configured || !baseURL) throw new MemberAuthUnavailableError();

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
      },
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 3,
        storeOTP: "hashed",
        async sendVerificationOTP({ email, otp }) {
          // Last line of defence: the identity plugin refuses placeholder
          // addresses before an OTP row exists. Should one still get here,
          // never hand it to the sender and report the send as failed.
          if (isPlaceholderEmail(email)) {
            memberEmailDeliveryFailed();
            return;
          }
          try {
            if (!available.email) throw new APIError("SERVICE_UNAVAILABLE", { message: "Email sign-in is not available yet." });
            const resend = new Resend(process.env.RESEND_API_KEY);
            const { error } = await resend.emails.send({
              from: process.env.EMAIL_FROM!,
              to: email,
              subject: "Your Superteam NL HQ sign-in code",
              text: `Your Superteam NL HQ code is ${otp}.\n\nIt expires in 5 minutes. If you did not request this code, you can ignore this email.`,
            });
            if (error) memberEmailDeliveryFailed();
          } catch {
            memberEmailDeliveryFailed();
          }
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
