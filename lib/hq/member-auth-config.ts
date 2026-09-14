export type MemberAuthAvailability = {
  configured: boolean;
  email: boolean;
  telegram: boolean;
};

type AuthEnvironment = Record<string, string | undefined>;

export function memberAuthOrigin(env: AuthEnvironment = process.env): string | null {
  try {
    const url = new URL(env.BETTER_AUTH_URL ?? "");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    if (url.protocol !== "https:" && !(env.NODE_ENV !== "production" && local && url.protocol === "http:")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Whether the member cookies carry the Secure attribute and the __Secure-
 * name prefix: exactly when the configured origin is https, which is every
 * origin `memberAuthOrigin` accepts except http://localhost outside
 * production. Better Auth takes the prefix from the baseURL scheme but the
 * attribute from `defaultCookieAttributes` (cookies/index.mjs), so both are
 * set from this one answer and can never disagree.
 */
export function memberAuthUsesSecureCookies(env: AuthEnvironment = process.env): boolean {
  return memberAuthOrigin(env)?.startsWith("https:") ?? false;
}

export function getMemberAuthAvailability(env: AuthEnvironment = process.env): MemberAuthAvailability {
  const configured = Boolean(env.DATABASE_URL && (env.BETTER_AUTH_SECRET?.length ?? 0) >= 32 && memberAuthOrigin(env));
  return {
    configured,
    email: configured && Boolean(env.RESEND_API_KEY && env.EMAIL_FROM),
    // Email and Telegram are the only public sign-in methods; no other
    // credentials in the environment can add one.
    // TELEGRAM_BOT_USERNAME is UI copy only and does not gate availability.
    telegram: configured && Boolean(env.TELEGRAM_LOGIN_CLIENT_ID && env.TELEGRAM_LOGIN_CLIENT_SECRET),
  };
}

// The post-auth destination allowlist lives with the member route list, so
// the proxy and the redirects read the same routes; re-exported here for the
// sign-in surfaces that already import it from this module.
export { safeMemberNext } from "./member-routes";
