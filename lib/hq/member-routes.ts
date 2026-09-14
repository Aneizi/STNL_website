// The public HQ route list, in one place. The proxy lets these paths past
// the operator cookie gate and safeMemberNext() lets them be a post-auth
// destination; a route added here is known to both at once.
//
// Client-safe on purpose: this module is bundled for the browser through
// member-auth-config.ts and the sign-in form, so it holds paths and nothing
// else. Neither list is authorization: every member page keeps its own gate.

/**
 * Every member page. An entry ending in "/" names a subtree whose next and
 * last segment is a single id (a team's project id, an invitation token);
 * every other entry is matched exactly. "/hq/invite/" is the invitation
 * continuation path reserved for phase 4: accepted as a destination now so a
 * sign-in that started from an invitation can return to it.
 */
export const MEMBER_PUBLIC_PATHS = [
  "/hq/signin",
  "/hq/profile",
  "/hq/welcome",
  "/hq/dashboard",
  "/hq/initialize",
  "/hq/join",
  "/hq/team/",
  "/hq/account",
  "/hq/account/connect-telegram",
  "/hq/account/disconnect-telegram",
  "/hq/account/add-email",
  "/hq/captain",
  "/hq/invite/",
] as const;

/** The one id segment a subtree entry accepts: a UUID, an invite token, nothing with a slash, a dot or an escape in it. */
const ID_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** True for exactly the paths in MEMBER_PUBLIC_PATHS, as a normalised pathname (no query, no fragment). */
export function isMemberPath(pathname: string): boolean {
  return MEMBER_PUBLIC_PATHS.some((entry) =>
    entry.endsWith("/") ? pathname.startsWith(entry) && ID_SEGMENT.test(pathname.slice(entry.length)) : pathname === entry,
  );
}

/** Where a member lands when the requested destination is not one of ours. */
const MEMBER_FALLBACK = "/hq/welcome";

/**
 * Keeps authentication redirects within public HQ, never the admin surface
 * and never another origin. Same-origin relative paths only (no scheme, no
 * "//", no backslash, no control character), resolved so ".." cannot climb,
 * then matched against the member route list. The query is kept for the
 * page it belongs to; the fragment is dropped.
 */
export function safeMemberNext(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020]/.test(value)) return MEMBER_FALLBACK;
  try {
    const url = new URL(value, "https://hq.invalid");
    if (url.origin !== "https://hq.invalid" || !isMemberPath(url.pathname)) return MEMBER_FALLBACK;
    return `${url.pathname}${url.search}`;
  } catch {
    return MEMBER_FALLBACK;
  }
}
