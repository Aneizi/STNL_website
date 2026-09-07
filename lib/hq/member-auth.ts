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
import { memberEmailDeliveryFailed } from "./member-auth-delivery";

export type MemberSessionUser = { id: string; email: string; name: string };

export class MemberAuthUnavailableError extends Error {
  constructor() {
    super("Account sign-in is not available yet. Please try again later.");
    this.name = "MemberAuthUnavailableError";
  }
}

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
    user: { modelName: "hq_auth_user" },
    session: {
      modelName: "hq_auth_session",
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    account: { modelName: "hq_auth_account", encryptOAuthTokens: true },
    verification: { modelName: "hq_auth_verification" },
    advanced: {
      cookiePrefix: "stnl_builder",
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress: { ipAddressHeaders: ["x-real-ip"] },
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" },
    },
    socialProviders: {
      ...(available.google ? { google: { clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! } } : {}),
      ...(available.github ? { github: { clientId: process.env.GITHUB_CLIENT_ID!, clientSecret: process.env.GITHUB_CLIENT_SECRET! } } : {}),
    },
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
            if (user.emailVerified && user.name.trim()) await syncBuilderAccount({ id: user.id, email: user.email, name: user.name.trim() });
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

export const currentMember = cache(async (): Promise<MemberSessionUser | null> => {
  if (!getMemberAuthAvailability().configured) return null;
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session?.user.emailVerified) return null;
  const user = { id: session.user.id, email: session.user.email, name: session.user.name };
  // Also repairs an interrupted CRM sync without duplicating People entries.
  if (user.name.trim()) await syncBuilderAccount({ ...user, name: user.name.trim() });
  return user;
});

export async function requireMember(next = "/hq/welcome"): Promise<MemberSessionUser> {
  const destination = safeMemberNext(next);
  const user = await currentMember();
  if (!user) redirect(`/hq/signin?next=${encodeURIComponent(destination)}`);
  if (!user.name.trim()) redirect(`/hq/profile?next=${encodeURIComponent(destination)}`);
  return user;
}
