// The public HQ route list, in one place. The proxy lets these paths past
// the operator cookie gate. safeMemberNext() permits the same destinations
// except login pages, which would loop after authentication.
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
 * The team join-link subtree. Distinct from INVITE_PATH_PREFIX above, which
 * is the admin-generated *Captain* invitation: this one is a team's own join
 * link, created by the account that imported the team, and it grants roster
 * membership, never a capability.
 */
const JOIN_PATH_PREFIX = "/hq/join/";

/**
 * The Captain board. Named because three places link to it from outside the
 * page itself (the bot's Open HQ buttons, phase 8's reminder and the list
 * below), and a fourth literal would be a fourth chance to disagree.
 */
export const CAPTAIN_PATH = "/hq/captain";

/** Login and its compatibility redirect are public, but never post-auth destinations. */
const MEMBER_LOGIN_PATHS = ["/hq/login", "/hq/signin"] as const;

/**
 * Every member page. An entry ending in "/" names a subtree whose next and
 * last segment is a single id (a team's project id, an invitation token);
 * every other entry is matched exactly. The invitation continuation path is
 * reserved for phase 4: accepted as a destination now so a sign-in that
 * started from an invitation can return to it.
 */
export const MEMBER_PUBLIC_PATHS = [
  ...MEMBER_LOGIN_PATHS,
  "/hq/profile",
  "/hq/welcome",
  "/hq/dashboard",
  "/hq/initialize",
  "/hq/join",
  // A join link is one code segment under /hq/join/, so a teammate who
  // clicks the link their importer sent lands on the same screen a pasted
  // link reaches. See joinLink() and parseJoinCode() below.
  JOIN_PATH_PREFIX,
  "/hq/team/",
  "/hq/hackathon/",
  // Connect Telegram, Disconnect Telegram and Add or Change email are modals
  // on the account page, not pages of their own.
  "/hq/account",
  CAPTAIN_PATH,
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

/** The path a team join link points at. Assembled here only, like inviteLink above. */
export function joinLink(code: string): string {
  return `${JOIN_PATH_PREFIX}${code}`;
}

/** A join code as the store hashes it: hex in six-character groups, as createInvite formats it. */
const JOIN_CODE = /^[0-9A-Fa-f-]{20,40}$/;

/**
 * The code inside whatever the joiner pasted.
 *
 * "Accept the full pasted link, and also a bare code, rather than failing on
 * a trailing slash, surrounding whitespace or a tracking query the messenger
 * appended." So: trim, drop a fragment and a query, take the last non-empty
 * path segment of anything that looks like a URL or a path, and accept a bare
 * code as itself. Returns null when nothing in the input can be a code, which
 * the caller answers with the "not a link we recognise" message — never with
 * anything about a team.
 *
 * Pure and client-safe, like the rest of this module: the join screen uses it
 * to decide whether to enable its button, and the action uses it again on the
 * server, because a client-side normalisation is never the one that counts.
 */
export function parseJoinCode(pasted: string): string | null {
  const trimmed = String(pasted ?? "").trim();
  if (!trimmed || trimmed.length > 2048) return null;
  const withoutFragment = trimmed.split("#")[0].split("?")[0];
  const candidate = withoutFragment.includes("/")
    ? withoutFragment.split("/").filter(Boolean).pop() ?? ""
    : withoutFragment;
  // Internal whitespace goes too: a code copied out of a chat message can
  // arrive with the display grouping broken across a line.
  const code = candidate.replace(/\s+/g, "");
  return JOIN_CODE.test(code) ? code : null;
}

/**
 * The invitation continuation page (task T4.3's step 2), the one other path
 * under the invitation subtree: the exchange route, the accept action and
 * the page itself all import this rather than repeating the literal, so
 * none of the three can drift from the others or from MEMBER_PUBLIC_PATHS.
 * "continue" is itself just an ID_SEGMENT match, so no change to that list
 * is needed for it to be accepted here or by safeMemberNext().
 */
export const INVITE_CONTINUE_PATH = `${INVITE_PATH_PREFIX}continue`;

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
 * then matched against the member route list, excluding login pages. The
 * query is kept for the page it belongs to; the fragment is dropped.
 */
export function safeMemberNext(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020]/.test(value)) return MEMBER_FALLBACK;
  try {
    const url = new URL(value, "https://hq.invalid");
    if (url.origin !== "https://hq.invalid" || !isMemberPath(url.pathname) || MEMBER_LOGIN_PATHS.some((path) => path === url.pathname)) return MEMBER_FALLBACK;
    return `${url.pathname}${url.search}`;
  } catch {
    return MEMBER_FALLBACK;
  }
}
