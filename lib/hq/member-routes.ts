// The public HQ route list, in one place. The proxy lets these paths past
// the operator cookie gate and safeMemberNext() lets them be a post-auth
// destination; a route added here is known to both at once.
//
// Client-safe on purpose: this module is bundled for the browser through
// member-auth-config.ts and the sign-in form, so it holds paths and nothing
// else. Neither list is authorization: every member page keeps its own gate.

/**
 * The invitation subtree's prefix, named once so the member route list below
 * and inviteLink() (the one place a full invitation link is assembled) share
 * it instead of repeating the literal — an admin-facing link and the route
 * that must accept it can then never drift apart.
 */
const INVITE_PATH_PREFIX = "/hq/invite/";

/**
 * Every member page. An entry ending in "/" names a subtree whose next and
 * last segment is a single id (a team's project id, an invitation token);
 * every other entry is matched exactly. The invitation continuation path is
 * reserved for phase 4: accepted as a destination now so a sign-in that
 * started from an invitation can return to it.
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
  INVITE_PATH_PREFIX,
] as const;

/**
 * The full path to a Captain invitation's landing page for a given token.
 * The one place this is assembled — task T4.3's /hq/invite/<token> route and
 * any admin-facing link builder (components/hq/builder-admin.tsx) both use
 * this instead of concatenating the prefix themselves, so they cannot
 * disagree about it.
 */
export function inviteLink(token: string): string {
  return `${INVITE_PATH_PREFIX}${token}`;
}

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
