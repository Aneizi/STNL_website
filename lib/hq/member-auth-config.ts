export type MemberAuthAvailability = {
  configured: boolean;
  email: boolean;
  google: boolean;
  github: boolean;
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

export function getMemberAuthAvailability(env: AuthEnvironment = process.env): MemberAuthAvailability {
  const configured = Boolean(env.DATABASE_URL && (env.BETTER_AUTH_SECRET?.length ?? 0) >= 32 && memberAuthOrigin(env));
  return {
    configured,
    email: configured && Boolean(env.RESEND_API_KEY && env.EMAIL_FROM),
    google: configured && Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    github: configured && Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
  };
}

/** Keep authentication redirects within public HQ, never the admin surface. */
export function safeMemberNext(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020]/.test(value)) return "/hq/welcome";
  try {
    const url = new URL(value, "https://hq.invalid");
    const routes = ["/hq/welcome", "/hq/dashboard", "/hq/join", "/hq/initialize", "/hq/profile"];
    const isTeam = /^\/hq\/team\/[a-zA-Z0-9_-]+$/.test(url.pathname);
    if (url.origin !== "https://hq.invalid" || (!routes.includes(url.pathname) && !isTeam)) return "/hq/welcome";
    return `${url.pathname}${url.search}`;
  } catch {
    return "/hq/welcome";
  }
}
