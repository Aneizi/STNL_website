// Phase 0 gate: proves that Telegram OIDC sign-in yields a real HQ account
// without any email, against the installed Better Auth, with the SQL applied
// through the migrate.ts splitter. Only the network (fetch), Resend and the
// Next.js request helpers are stubbed; every value below is fictional.
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { betterAuth } from "better-auth";
import { supportsIdTokenSignIn } from "@better-auth/core/oauth2";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { Pool } from "pg";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithEndpointContext } from "@better-auth/core/context";
import { applyMigrations } from "./helpers/db";
import { getTelegramIdentity } from "@/lib/hq/identity";
import { getBotConsent } from "@/lib/hq/telegram-consent";
import { hqTelegramIdentity, PLACEHOLDER_GUARDED_ENDPOINTS, RECENT_SESSION_ENDPOINTS, recordTelegramIntent } from "@/lib/hq/telegram-identity-plugin";
import { parseTelegramClaims, TELEGRAM_ISSUER, TELEGRAM_REJECTION_LOG_PREFIX, telegramProvider } from "@/lib/hq/telegram-provider";

const state = vi.hoisted(() => ({
  pg: null as PGlite | null,
  sent: [] as Array<{ to: string; subject: string; text: string; html?: string; attachments?: import("resend").Attachment[] }>,
  synced: vi.fn(),
  cookie: "",
  fetches: [] as string[],
  unexpected: [] as string[],
  tokenRequests: [] as Array<{ authorization: string | null; params: URLSearchParams }>,
  tokenOverride: {} as Record<string, unknown>,
  tokenFailure: false,
  nonce: "",
  minted: [] as string[],
}));

vi.mock("server-only", () => ({}));
// The icon package ships its source, so importing it makes vitest transform thousands of icons; the pages here render markup, not icons.
vi.mock("symbols-react", async () => {
  const { createElement } = await import("react");
  const icon = (props: Record<string, unknown>) => createElement("svg", props);
  return { IconArrowLeft: icon, IconArrowRight: icon, IconPaperplaneFill: icon };
});
vi.mock("next/headers", () => ({ headers: async () => new Headers({ Origin: "https://hq-test.example", Cookie: state.cookie }) }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); },
  // The account page carries a client control; static markup needs the hook to exist, not to navigate.
  useRouter: () => ({ replace() {}, refresh() {} }),
}));
vi.mock("@/lib/hq/builder-store", async (importOriginal) => {
  const store = await importOriginal<typeof import("@/lib/hq/builder-store")>();
  return { ...store, syncBuilderAccount: async (user: { id: string; email: string | null; name: string }) => {
    state.synced(user);
    await store.syncBuilderAccount(user);
  } };
});
vi.mock("pg", () => ({
  // Real PostgreSQL statements and constraints, with an in-process transport.
  Pool: class {
    async query(text: string, values: unknown[] = []) { return state.pg!.query(text, values); }
    async connect() {
      return {
        query: async (text: string, values: unknown[] = []) => state.pg!.query(text, values),
        release() {},
        on() {},
        removeListener() {},
      };
    }
    on() { return this; }
    async end() {}
  },
}));
vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async (message: { to: string; subject: string; text: string; html?: string; attachments?: import("resend").Attachment[] }) => {
        state.sent.push(message);
        return { error: null, data: { id: "test-email" } };
      },
    };
  },
}));

const ORIGIN = "https://hq-test.example";
const ISSUER = TELEGRAM_ISSUER;
const CLIENT_ID = "123456789";
const CLIENT_SECRET = "test-only-telegram-client-secret";
const SUB = "1234123412341234123";
// Above 2^32 so a 32-bit column or an int cast would truncate it.
const TELEGRAM_ID = 7_000_000_000_123;
const NAME = "Fictional Builder";
const USERNAME = "fictional_builder";
const PICTURE = "https://cdn.example.invalid/fictional-builder.jpg";
const PLACEHOLDER = `${SUB}@telegram.placeholder.invalid`;
const SECRET = "test-only-independent-auth-secret-0123456789";
const CREDENTIALS = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };

let route: typeof import("@/app/api/auth/[...all]/route");
let keys: { publicKey: CryptoKey; privateKey: CryptoKey };
let otherKeys: { publicKey: CryptoKey; privateKey: CryptoKey };
let requestNumber = 0;

type TokenOverride = {
  sub?: string; id?: number | string | null; nonce?: string | null; iss?: string; aud?: string;
  iat?: number; exp?: number | string; key?: CryptoKey; kid?: string; name?: string | null;
};

async function mintIdToken(o: TokenOverride = {}) {
  const payload: Record<string, unknown> = { preferred_username: USERNAME, picture: PICTURE };
  if (o.name !== null) payload.name = o.name ?? NAME;
  if (o.id !== null) payload.id = o.id ?? TELEGRAM_ID;
  if (o.nonce !== null) payload.nonce = o.nonce ?? state.nonce;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: o.kid ?? "test-1" })
    .setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? CLIENT_ID)
    .setSubject(o.sub ?? SUB)
    .setIssuedAt(o.iat)
    .setExpirationTime(o.exp ?? "1h")
    .sign(o.key ?? keys.privateKey);
}

function request(path: string, body?: object, cookie?: string, fixedIp?: string) {
  requestNumber += 1;
  // A fresh address per request keeps the library's per-IP limits out of the way unless a test pins one.
  const ip = fixedIp ?? `10.${Math.floor(requestNumber / 256) % 256}.${requestNumber % 256}.7`;
  return route[body ? "POST" : "GET"](new Request(`${ORIGIN}/api/auth${path}`, {
    method: body ? "POST" : "GET",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", "x-real-ip": ip, ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
}

const cookieHeader = (response: Response) => response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const sessionCookie = (response: Response) => response.headers.getSetCookie().find((c) => c.includes("stnl_builder.session_token=")) ?? null;
const errorCode = (response: Response) => new URL(response.headers.get("location")!, ORIGIN).searchParams.get("error");
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

async function count(table: string) {
  return Number((await state.pg!.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
}

async function startSignIn(extra: Record<string, unknown> = {}) {
  const response = await request("/sign-in/social", { provider: "telegram", callbackURL: "/hq/welcome", errorCallbackURL: "/hq/login", disableRedirect: true, ...extra });
  expect(response.status).toBe(200);
  const url = new URL((await response.json()).url);
  return { url, state: url.searchParams.get("state")!, nonce: url.searchParams.get("nonce")!, codeChallenge: url.searchParams.get("code_challenge")!, cookie: cookieHeader(response), setCookies: response.headers.getSetCookie() };
}

/**
 * The Set-Cookie lines the Telegram flow must produce on an https origin,
 * with NODE_ENV not production: the __Secure- prefix with the Secure
 * attribute it requires, HttpOnly, SameSite=Lax (the return from Telegram
 * is a top-level GET, which Strict would strip), no Domain. The signed state
 * lives five minutes, the session thirty days.
 */
const STATE_COOKIE_LINE = /^__Secure-stnl_builder\.state=[^;]+; Max-Age=300; Path=\/; HttpOnly; Secure; SameSite=Lax$/;
const SESSION_COOKIE_LINE = /^__Secure-stnl_builder\.session_token=[^;]+; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/;

async function completeCallback(start: Awaited<ReturnType<typeof startSignIn>>, cookie = start.cookie) {
  state.nonce = start.nonce;
  return request(`/callback/telegram?code=fictional-code&state=${encodeURIComponent(start.state)}`, undefined, cookie);
}

async function signInWithTelegram(override: TokenOverride = {}) {
  state.tokenOverride = override;
  const start = await startSignIn();
  const response = await completeCallback(start);
  return { start, response, session: sessionCookie(response) };
}

async function signInWithEmail(email: string, name = "Email Builder") {
  expect((await request("/email-otp/send-verification-otp", { email, type: "sign-in" })).status).toBe(200);
  const otp = state.sent.at(-1)!.text.match(/\b\d{6}\b/)![0];
  const response = await request("/sign-in/email-otp", { email, otp, name });
  expect(response.status).toBe(200);
  return { user: (await response.json()).user as { id: string }, cookie: sessionCookie(response)!.split(";")[0] };
}

const LINK_BODY = { provider: "telegram", callbackURL: "/hq/account?connected=telegram", errorCallbackURL: "/hq/account?error=telegram", disableRedirect: true };

/** The intent store the confirmation actions write to: Better Auth's own internal adapter. */
async function intentStore() {
  const { getAuth } = await import("@/lib/hq/member-auth");
  return (await getAuth().$context).internalAdapter;
}

/** Starts /link-social for the session behind `cookie`; the caller has confirmed (or not) beforehand. */
async function startLink(cookie: string) {
  const response = await request("/link-social", LINK_BODY, cookie);
  if (response.status !== 200) return { response, start: null };
  const url = new URL((await response.json()).url);
  return { response, start: { url, state: url.searchParams.get("state")!, nonce: url.searchParams.get("nonce")!, codeChallenge: url.searchParams.get("code_challenge")!, cookie: cookieHeader(response), setCookies: response.headers.getSetCookie() } };
}

/** The whole Connect Telegram flow for a signed-in member: confirmation step, /link-social, callback. */
async function linkTelegramTo(cookie: string, override: TokenOverride = {}) {
  state.cookie = cookie;
  const { confirmLinkTelegram } = await import("@/lib/hq/actions/telegram");
  expect(await confirmLinkTelegram()).toEqual({ ok: true });
  const { response, start } = await startLink(cookie);
  expect(response.status).toBe(200);
  state.tokenOverride = override;
  return completeCallback(start!);
}

async function auditEvents() {
  const { rows } = await state.pg!.query<{ kind: string; actor_kind: string; actor_id: string | null; subject_user_id: string | null; metadata: unknown }>(
    "SELECT kind, actor_kind, actor_id, subject_user_id, metadata FROM hq_audit_events ORDER BY id",
  );
  return rows;
}

const identityEvent = (kind: "identity.linked" | "identity.unlinked", userId: string) =>
  ({ kind, actor_kind: "member", actor_id: userId, subject_user_id: userId, metadata: { provider: "telegram" } });
const memberEvent = (kind: "identity.email_changed" | "bot.consent_changed", userId: string, metadata: Record<string, unknown>) =>
  ({ kind, actor_kind: "member", actor_id: userId, subject_user_id: userId, metadata });

/** The recorded confirmation intents for a user, if any. */
async function intents(userId: string) {
  return (await state.pg!.query<{ value: string }>("SELECT value FROM hq_auth_verification WHERE identifier = $1", [`hq-telegram-intent:${userId}`])).rows;
}

/** The pending change-email codes, which must never exist for a placeholder or a stale session. */
async function changeEmailRows() {
  return (await state.pg!.query<{ identifier: string }>("SELECT identifier FROM hq_auth_verification WHERE identifier ILIKE 'change-email%'")).rows;
}

/**
 * The two change-email endpoints for the session behind `cookie`, given a
 * recorded intent: request, the code from the one message sent, change.
 * Returns the change-email response; the caller asserts the outcome.
 */
async function changeEmailWithCode(cookie: string, newEmail: string) {
  const requested = await request("/email-otp/request-email-change", { newEmail }, cookie);
  expect(requested.status).toBe(200);
  const otp = state.sent.at(-1)!.text.match(/\b\d{6}\b/)![0];
  return request("/email-otp/change-email", { newEmail, otp }, cookie);
}

/** What linking must never touch: the account id, its profile, enrollments, capability grants and team rows. */
async function accountSnapshot(userId: string) {
  const one = async (sql: string) => (await state.pg!.query<{ n: number }>(sql, [userId])).rows[0].n;
  return {
    profile: (await state.pg!.query("SELECT id, email, name FROM hq_builder_profiles WHERE id = $1", [userId])).rows,
    enrollments: await one("SELECT count(*)::int AS n FROM hq_builder_enrollments WHERE user_id = $1"),
    capabilities: (await state.pg!.query("SELECT capability FROM hq_account_capabilities WHERE user_id = $1 AND revoked_at IS NULL", [userId])).rows,
    teams: await one("SELECT count(*)::int AS n FROM hq_project_members WHERE builder_user_id = $1"),
  };
}

describe("Telegram OIDC sign-in through Better Auth", () => {
  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", "postgres://test-only/member-auth-telegram");
    vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
    vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
    vi.stubEnv("RESEND_API_KEY", "test-only-sender");
    vi.stubEnv("EMAIL_FROM", "Superteam NL <test@example.com>");
    vi.stubEnv("TELEGRAM_LOGIN_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("TELEGRAM_LOGIN_CLIENT_SECRET", CLIENT_SECRET);
    keys = await generateKeyPair("RS256");
    otherKeys = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test-1", alg: "RS256", use: "sig" };
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      state.fetches.push(url);
      if (url === `${ISSUER}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
      if (url === `${ISSUER}/token`) {
        if (state.tokenFailure) throw new TypeError("fetch failed: oauth.telegram.org unreachable");
        state.tokenRequests.push({ authorization: new Headers(init?.headers).get("authorization"), params: new URLSearchParams(String(init?.body)) });
        const idToken = await mintIdToken(state.tokenOverride);
        state.minted.push(idToken);
        return Response.json({ access_token: "fictional-access-token", token_type: "Bearer", expires_in: 3600, id_token: idToken });
      }
      // The discovery document, or anything else, must never be requested.
      state.unexpected.push(url);
      return new Response("not found", { status: 404 });
    });
    state.pg = new PGlite();
    // Twice: the new DDL must be idempotent when applied through the splitter.
    await applyMigrations(state.pg);
    await applyMigrations(state.pg);
    route = await import("@/app/api/auth/[...all]/route");
  });

  beforeEach(async () => {
    state.sent.length = 0;
    state.synced.mockReset();
    state.cookie = "";
    state.fetches.length = 0;
    state.unexpected.length = 0;
    state.tokenRequests.length = 0;
    state.tokenOverride = {};
    state.tokenFailure = false;
    state.minted.length = 0;
    await state.pg!.exec("TRUNCATE hq_auth_user, hq_auth_verification, hq_auth_rate_limit, hq_builder_profiles, hq_hackathons, hq_project_statuses, hq_project_forecasts, hq_audit_events CASCADE");
    await state.pg!.exec(`INSERT INTO hq_hackathons(id,slug,name,start_date,end_date) VALUES(41,'test-builders','Test builders','2098-09-01','2098-10-01')`);
  });

  afterEach(() => {
    expect(state.unexpected, "only the JWKS and token endpoints may be fetched").toEqual([]);
  });

  afterAll(async () => {
    await state.pg?.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("starts an authorization-code request with PKCE and a server nonce, without any network I/O", async () => {
    const start = await startSignIn();
    expect(start.url.origin).toBe(ISSUER);
    expect(start.url.pathname).toBe("/auth");
    const p = start.url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe(CLIENT_ID);
    expect(p.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/telegram`);
    expect(p.get("scope")!.split(" ")).toContain("openid");
    expect(p.get("scope")).not.toContain("phone");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(start.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(start.state).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(start.nonce).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(start.cookie).toContain("stnl_builder.state=");
    expect(process.env.NODE_ENV).not.toBe("production");
    expect(start.setCookies).toEqual([expect.stringMatching(STATE_COOKIE_LINE)]);
    expect(state.fetches).toEqual([]);
  });

  it("completes the callback into a verified HQ account that has no email", async () => {
    const { start, response, session } = await signInWithTelegram();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(/\/hq\/welcome$/);
    expect(session).toMatch(SESSION_COOKIE_LINE);
    expect(session).not.toContain("hq_session=");

    // Only the JWKS and the token endpoint were contacted, never discovery.
    expect(state.fetches).toEqual([`${ISSUER}/token`, `${ISSUER}/.well-known/jwks.json`]);
    const [exchange] = state.tokenRequests;
    expect(exchange.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    expect(exchange.params.get("grant_type")).toBe("authorization_code");
    expect(exchange.params.get("code")).toBe("fictional-code");
    expect(exchange.params.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/telegram`);
    expect(exchange.params.get("client_id")).toBe(CLIENT_ID);
    expect(s256(exchange.params.get("code_verifier")!)).toBe(start.codeChallenge);

    const users = (await state.pg!.query<{ id: string; email: string; emailVerified: boolean; name: string }>('SELECT id, email, "emailVerified", name FROM hq_auth_user')).rows;
    expect(users).toEqual([{ id: expect.any(String), email: PLACEHOLDER, emailVerified: false, name: NAME }]);
    const userId = users[0].id;
    expect((await state.pg!.query('SELECT "providerId", issuer, "accountId", "userId" FROM hq_auth_account')).rows).toEqual([
      { providerId: "telegram", issuer: ISSUER, accountId: SUB, userId },
    ]);
    expect((await state.pg!.query(`SELECT user_id, provider_subject, telegram_user_id::text AS telegram_user_id, username, photo_url FROM hq_auth_telegram_identity`)).rows).toEqual([
      { user_id: userId, provider_subject: SUB, telegram_user_id: String(TELEGRAM_ID), username: USERNAME, photo_url: PICTURE },
    ]);
    expect(state.sent).toEqual([]);

    const cookie = session!.split(";")[0];
    expect((await (await request("/get-session", undefined, cookie)).json()).user.id).toBe(userId);

    // The gate assertion: a member without any email, read the way pages read it.
    state.cookie = cookie;
    const { currentMember, requireMember } = await import("@/lib/hq/member-auth");
    expect(await currentMember()).toEqual({ id: userId, email: null, name: NAME });
    expect((await requireMember("/hq/welcome")).id).toBe(userId);
    // The CRM sync is null-safe: the account gets a profile with no email and a person; the placeholder is stored nowhere.
    expect(state.synced).toHaveBeenCalledWith({ id: userId, email: null, name: NAME });
    expect((await state.pg!.query("SELECT email, contact_email FROM hq_builder_profiles")).rows).toEqual([{ email: null, contact_email: null }]);
    expect(await count("hq_crm_persons")).toBe(1);
    expect((await state.pg!.query("SELECT count(*)::int AS n FROM hq_people WHERE contact ILIKE '%placeholder.invalid%'")).rows).toEqual([{ n: 0 }]);

    // Fail closed: the session alone is not enough once the identity row is gone.
    // The gate then ends that session and sends the person to sign in again, saying why.
    await state.pg!.exec("DELETE FROM hq_auth_telegram_identity");
    expect(await currentMember()).toBeNull();
    await expect(requireMember("/hq/welcome")).rejects.toThrow("REDIRECT:/hq/login?error=identity_missing&next=%2Fhq%2Fwelcome");
    expect(await count("hq_auth_session")).toBe(0);
    expect(await (await request("/get-session", undefined, cookie)).json()).toBeNull();
  });

  it("accepts Telegram's string user id and preserves the same account across numeric and string claims", async () => {
    let userId: string | undefined;
    for (const id of [String(TELEGRAM_ID), TELEGRAM_ID, String(TELEGRAM_ID)]) {
      const { response, session } = await signInWithTelegram({ id });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toMatch(/\/hq\/welcome$/);
      expect(session).toMatch(SESSION_COOKIE_LINE);
      const authenticated = await (await request("/get-session", undefined, session!.split(";")[0])).json();
      userId ??= authenticated.user.id;
      expect(authenticated.user.id).toBe(userId);
      expect((await state.pg!.query('SELECT "accountId", "userId" FROM hq_auth_account')).rows).toEqual([{ accountId: SUB, userId }]);
      expect((await state.pg!.query("SELECT user_id, provider_subject, telegram_user_id::text AS telegram_user_id FROM hq_auth_telegram_identity")).rows).toEqual([
        { user_id: userId, provider_subject: SUB, telegram_user_id: String(TELEGRAM_ID) },
      ]);
    }
    expect(await count("hq_auth_user")).toBe(1);
    expect(await count("hq_auth_session")).toBe(3);
    expect(await auditEvents()).toEqual([identityEvent("identity.linked", userId!)]);
  });

  it("diagnoses an incomplete Telegram identity without logging private claim values", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { response, session } = await signInWithTelegram({ id: null });
      expect(errorCode(response)).toBe("telegram_identity_incomplete");
      expect(session).toBeNull();
      expect(await count("hq_auth_user")).toBe(0);
      expect(await count("hq_auth_account")).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      const diagnostic = JSON.stringify(warn.mock.calls);
      expect(diagnostic).toContain("hq-telegram-identity: incomplete identity");
      for (const privateValue of [state.minted.at(-1)!, SUB, NAME, USERNAME, PICTURE, state.nonce, CLIENT_SECRET]) {
        expect(diagnostic).not.toContain(privateValue);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses replayed, unbound, forged and stale callbacks", async () => {
    const first = await signInWithTelegram();
    expect(first.response.status).toBe(302);
    const replay = await completeCallback(first.start);
    expect(replay.status).toBe(302);
    expect(errorCode(replay)).toBe("state_mismatch");
    expect(sessionCookie(replay)).toBeNull();
    const withoutCookie = await completeCallback(await startSignIn(), "");
    expect(errorCode(withoutCookie)).toBe("state_mismatch");

    const now = Math.floor(Date.now() / 1000);
    const forged: Array<[string, TokenOverride, RegExp]> = [
      ["wrong nonce", { nonce: "not-the-nonce-that-was-sent-0000" }, /nonce does not match/],
      ["missing nonce", { nonce: null }, /nonce does not match/],
      ["wrong audience", { aud: "987654321" }, /"aud"/],
      ["wrong issuer", { iss: "https://oauth.example.invalid" }, /"iss"/],
      ["expired", { iat: now - 120, exp: now - 60 }, /"exp"/],
      ["too old", { iat: now - 3600, exp: "1h" }, /too far in the past|"iat"/],
      ["another key", { key: otherKeys.privateKey }, /signature/i],
      ["unknown key id", { kid: "unknown-1" }, /no applicable key|JWKS/i],
    ];
    // Every rejection emits exactly one diagnostic line naming the reason, never the token or its claims.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [label, override, reason] of forged) {
      warn.mockClear();
      const { response, session } = await signInWithTelegram(override);
      expect(response.status, label).toBe(302);
      expect(errorCode(response), label).toBe("unable_to_get_user_info");
      expect(session, label).toBeNull();
      expect(warn, label).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line, label).toContain(TELEGRAM_REJECTION_LOG_PREFIX);
      expect(line, label).toMatch(reason);
      expect(line, label).not.toContain(state.minted.at(-1)!);
      expect(line, label).not.toContain(SUB);
      expect(line, label).not.toContain(NAME);
    }
    warn.mockRestore();
    expect(await count("hq_auth_user")).toBe(1);
    expect(await count("hq_auth_session")).toBe(1);

    // A state without a nonce is refused before the code is even exchanged.
    const unbound = await startSignIn();
    await state.pg!.query(`UPDATE hq_auth_verification SET value = (value::jsonb - 'idTokenNonce')::text WHERE identifier = $1`, [unbound.state]);
    const exchanges = state.tokenRequests.length;
    const response = await completeCallback(unbound);
    expect(errorCode(response)).toBe("nonce_binding_missing");
    expect(state.tokenRequests).toHaveLength(exchanges);
  });

  it("signs a returning Telegram user into the same account", async () => {
    const first = await signInWithTelegram();
    const userId = (await state.pg!.query<{ id: string }>("SELECT id FROM hq_auth_user")).rows[0].id;
    await state.pg!.exec("UPDATE hq_auth_telegram_identity SET last_login_at = now() - interval '1 day'");
    const second = await signInWithTelegram();
    expect(second.response.status).toBe(302);
    expect(second.session).not.toBeNull();
    expect(second.session).not.toBe(first.session);
    expect(await count("hq_auth_user")).toBe(1);
    expect(await count("hq_auth_account")).toBe(1);
    expect(await count("hq_auth_telegram_identity")).toBe(1);
    expect(await count("hq_auth_session")).toBe(2);
    const identity = (await state.pg!.query<{ user_id: string; fresh: boolean }>(`SELECT user_id, last_login_at > now() - interval '1 hour' AS fresh FROM hq_auth_telegram_identity`)).rows[0];
    expect(identity).toEqual({ user_id: userId, fresh: true });

    const read = await getTelegramIdentity(userId);
    expect(read).toEqual({
      userId, telegramUserId: String(TELEGRAM_ID), providerSubject: SUB, username: USERNAME, photoUrl: PICTURE,
      linkedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      lastLoginAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });
    expect(Date.parse(read!.lastLoginAt)).toBeGreaterThan(Date.parse(read!.linkedAt));
    expect(await getTelegramIdentity("nobody")).toBeNull();
  });

  it("rate-limits the Telegram callback per IP without touching Telegram", async () => {
    const ip = "203.0.113.9";
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const response = await request("/callback/telegram?code=fictional-code&state=not-a-real-state", undefined, undefined, ip);
      expect(response.status, `attempt ${attempt}`).toBe(302);
      expect(errorCode(response), `attempt ${attempt}`).toBe("state_mismatch");
    }
    expect((await request("/callback/telegram?code=fictional-code&state=not-a-real-state", undefined, undefined, ip)).status).toBe(429);
    expect(state.fetches).toEqual([]);
  });

  it("removes the identity row when the Telegram account row is deleted", async () => {
    await signInWithTelegram();
    const { getAuth } = await import("@/lib/hq/member-auth");
    const context = await getAuth().$context;
    const accountId = (await state.pg!.query<{ id: string }>("SELECT id FROM hq_auth_account")).rows[0].id;
    await context.internalAdapter.deleteAccount(accountId);
    expect(await count("hq_auth_account")).toBe(0);
    expect(await count("hq_auth_telegram_identity")).toBe(0);
    expect(await count("hq_auth_user")).toBe(1);
  });

  it("never accepts a client-supplied id_token, with each fence sufficient on its own", async () => {
    const token = await mintIdToken({ nonce: null });
    const refused = await request("/sign-in/social", { provider: "telegram", idToken: { token } });
    expect(refused.status).toBe(400);
    expect((await refused.json()).code).toBe("id_token_not_accepted");
    expect(sessionCookie(refused)).toBeNull();
    expect(await count("hq_auth_user")).toBe(0);

    const { session } = await signInWithTelegram();
    const cookie = session!.split(";")[0];
    const link = await request("/link-social", { provider: "telegram", idToken: { token } }, cookie);
    expect(link.status).toBe(400);
    expect((await link.json()).code).toBe("id_token_not_accepted");
    expect(await count("hq_auth_account")).toBe(1);
    expect(await count("hq_auth_session")).toBe(1);

    // Fence 1, the provider option: the library itself refuses the branch.
    expect(supportsIdTokenSignIn(telegramProvider(CREDENTIALS))).toBe(false);

    // Same database, same secret, one fence at a time.
    const open = { ...telegramProvider(CREDENTIALS), options: { ...CREDENTIALS }, idToken: { jwks: async () => keys.publicKey, audience: CLIENT_ID, issuer: ISSUER } };
    const instance = (plugins: Parameters<typeof betterAuth>[0]["plugins"]) => betterAuth({
      baseURL: ORIGIN, secret: SECRET, database: new Pool(), plugins,
      user: { modelName: "hq_auth_user" }, session: { modelName: "hq_auth_session" },
      account: { modelName: "hq_auth_account" }, verification: { modelName: "hq_auth_verification" },
      advanced: { cookiePrefix: "stnl_builder" },
    });
    const providerOnly = instance([{ id: "test-provider-only", init: (ctx) => ({ context: { socialProviders: [telegramProvider(CREDENTIALS), ...ctx.socialProviders] } }) }]);
    const hookOnly = instance([hqTelegramIdentity({ provider: null }), { id: "test-open-provider", init: (ctx) => ({ context: { socialProviders: [open, ...ctx.socialProviders] } }) }]);
    const neither = instance([{ id: "test-open-provider", init: (ctx) => ({ context: { socialProviders: [open, ...ctx.socialProviders] } }) }]);
    const headers = new Headers({ origin: ORIGIN, cookie });
    // A handler throw becomes a Response; a before-hook throw surfaces as the APIError itself on direct API calls.
    const outcome = async (run: () => Promise<Response>) => {
      try {
        const response = await run();
        return { status: response.status, code: (await response.json()).code as string };
      } catch (error) {
        const failure = error as { statusCode?: number; body?: { code?: string } };
        return { status: failure.statusCode, code: failure.body?.code };
      }
    };
    for (const [auth, status, code] of [[providerOnly, 404, "ID_TOKEN_NOT_SUPPORTED"], [hookOnly, 400, "id_token_not_accepted"]] as const) {
      expect(await outcome(() => auth.api.signInSocial({ body: { provider: "telegram", idToken: { token } }, headers, asResponse: true }))).toEqual({ status, code });
      expect(await outcome(() => auth.api.linkSocialAccount({ body: { provider: "telegram", idToken: { token } }, headers, asResponse: true }))).toEqual({ status, code });
    }
    // Control: with neither fence the request passes both checks and is stopped only by getUserInfo refusing to run without a server nonce.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await outcome(() => neither.api.signInSocial({ body: { provider: "telegram", idToken: { token } }, headers, asResponse: true }))).toEqual({ status: 401, code: "FAILED_TO_GET_USER_INFO" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/no server nonce/);
    warn.mockRestore();
    expect(await count("hq_auth_user")).toBe(1);
    expect(await count("hq_auth_account")).toBe(1);
    expect(await count("hq_auth_session")).toBe(1);
  });

  it("never mails, looks up or verifies a placeholder address", async () => {
    const { session } = await signInWithTelegram();
    const cookie = session!.split(";")[0];
    const accounts = await count("hq_auth_account");
    const verifications = () => state.pg!.query(`SELECT identifier FROM hq_auth_verification WHERE identifier ILIKE '%placeholder.invalid%'`).then((r) => r.rows);

    for (const email of [PLACEHOLDER, "someone@anonymous.placeholder.invalid"]) {
      const send = await request("/email-otp/send-verification-otp", { email, type: "sign-in" });
      expect(send.status).toBe(400);
      expect((await send.json()).code).toBe("placeholder_email_not_allowed");
    }
    const signIn = await request("/sign-in/email-otp", { email: PLACEHOLDER, otp: "000000" });
    expect(signIn.status).toBe(400);
    expect((await signIn.json()).code).toBe("placeholder_email_not_allowed");
    const change = await request("/email-otp/request-email-change", { newEmail: PLACEHOLDER }, cookie);
    expect(change.status).toBe(400);
    expect((await change.json()).code).toBe("placeholder_email_not_allowed");

    // Nor is a placeholder ever a new address: the confirmation refuses it before any intent exists, and both change-email routes refuse it before any row does.
    state.cookie = cookie;
    const userId = (await state.pg!.query<{ id: string }>("SELECT id FROM hq_auth_user")).rows[0].id;
    const { confirmEmailChange } = await import("@/lib/hq/actions/telegram");
    for (const email of [PLACEHOLDER, "someone@anonymous.placeholder.invalid", " Someone@Anonymous.Placeholder.Invalid "]) {
      expect(await confirmEmailChange(email), email).toEqual({ ok: false, code: "INVALID_EMAIL" });
    }
    expect(await intents(userId)).toEqual([]);
    for (const [path, body] of [["/email-otp/change-email", { newEmail: PLACEHOLDER, otp: "000000" }], ["/change-email", { newEmail: PLACEHOLDER }]] as const) {
      const response = await request(path, body, cookie);
      expect(response.status, path).toBe(400);
      expect((await response.json()).code, path).toBe("placeholder_email_not_allowed");
    }

    expect(state.sent).toEqual([]);
    expect(await verifications()).toEqual([]);
    expect(await changeEmailRows()).toEqual([]);
    expect(await count("hq_auth_account")).toBe(accounts);
    expect(await count("hq_auth_session")).toBe(1);

    // The database hook closes updateUser as well, which never runs validateUserInfo.
    const { getAuth } = await import("@/lib/hq/member-auth");
    const context = await getAuth().$context;
    await expect(context.internalAdapter.updateUser(userId, { email: "another@telegram.placeholder.invalid" })).rejects.toMatchObject({ body: { code: "placeholder_email_not_allowed" } });
    expect((await context.internalAdapter.updateUser(userId, { name: "Renamed Builder" }))?.name).toBe("Renamed Builder");

    // The one exemption is the Telegram callback rewriting a placeholder the user already holds (the
    // core's override-on-sign-in path). A placeholder nobody holds would replace a real address, so it is
    // refused there too, as is any placeholder on another provider's callback or on the change-email route.
    const refused = { body: { code: "placeholder_email_not_allowed" } };
    const within = (path: string, id: string | undefined, run: () => Promise<unknown>) =>
      runWithEndpointContext({ path, params: id === undefined ? {} : { id }, context } as unknown as Parameters<typeof runWithEndpointContext>[0], run);
    expect(await within("/callback/:id", "telegram", () => context.internalAdapter.updateUser(userId, { email: PLACEHOLDER }))).toMatchObject({ id: userId, email: PLACEHOLDER });
    await expect(within("/callback/:id", "telegram", () => context.internalAdapter.updateUser(userId, { email: "another@telegram.placeholder.invalid" }))).rejects.toMatchObject(refused);
    await expect(within("/callback/:id", "github", () => context.internalAdapter.updateUser(userId, { email: PLACEHOLDER }))).rejects.toMatchObject(refused);
    await expect(within("/callback/:id", undefined, () => context.internalAdapter.updateUser(userId, { email: PLACEHOLDER }))).rejects.toMatchObject(refused);
    await expect(within("/email-otp/change-email", undefined, () => context.internalAdapter.updateUser(userId, { email: PLACEHOLDER }))).rejects.toMatchObject(refused);
    await expect(within("/change-email", undefined, () => context.internalAdapter.updateUser(userId, { email: PLACEHOLDER }))).rejects.toMatchObject(refused);
    // An account with a real address keeps it even on the Telegram callback: a placeholder nobody holds is
    // refused by the hook, and one somebody else holds passes the hook only to hit the unique email index.
    const linked = await signInWithEmail("linked@example.com", "Linked Builder");
    await expect(within("/callback/:id", "telegram", () => context.internalAdapter.updateUser(linked.user.id, { email: "another@telegram.placeholder.invalid" }))).rejects.toMatchObject(refused);
    await expect(within("/callback/:id", "telegram", () => context.internalAdapter.updateUser(linked.user.id, { email: PLACEHOLDER }))).rejects.toThrow(/hq_auth_user_email_key|unique/i);
    expect((await state.pg!.query("SELECT email FROM hq_auth_user ORDER BY email")).rows).toEqual([{ email: PLACEHOLDER }, { email: "linked@example.com" }]);
  });

  it("refuses a Telegram identity another account already holds, before any row is committed", async () => {
    await state.pg!.exec(`INSERT INTO hq_auth_user(id, name, email, "emailVerified") VALUES ('user-b', 'Other Builder', 'other@example.com', true)`);
    await state.pg!.query(`INSERT INTO hq_auth_telegram_identity(user_id, provider_subject, telegram_user_id) VALUES ('user-b', '9876543210987654321', $1::bigint)`, [String(TELEGRAM_ID)]);

    for (const override of [{ sub: "5555555555555555555" }, { sub: "9876543210987654321", id: 4_200_000_000_042 }]) {
      const { response, session } = await signInWithTelegram(override);
      expect(response.status).toBe(302);
      expect(errorCode(response)).toBe("telegram_identity_conflict");
      expect(session).toBeNull();
    }
    expect((await state.pg!.query("SELECT id FROM hq_auth_user")).rows).toEqual([{ id: "user-b" }]);
    expect(await count("hq_auth_account")).toBe(0);
    expect(await count("hq_auth_session")).toBe(0);
    expect(await count("hq_auth_telegram_identity")).toBe(1);
  });

  it("keeps email sign-in and existing sessions working while Telegram is unreachable", async () => {
    const emailUser = await signInWithEmail("still-here@example.com");
    state.tokenFailure = true;
    const { response, session } = await signInWithTelegram();
    expect(response.status).toBe(302);
    expect(errorCode(response)).toBe("invalid_code");
    expect(session).toBeNull();

    expect((await request("/email-otp/send-verification-otp", { email: "another@example.com", type: "sign-in" })).status).toBe(200);
    expect(state.sent).toHaveLength(2);
    expect((await (await request("/get-session", undefined, emailUser.cookie)).json()).user.id).toBe(emailUser.user.id);
    expect(await count("hq_auth_user")).toBe(1);
  });

  it("guards and gates endpoints that exist on the installed library", async () => {
    const { getAuth } = await import("@/lib/hq/member-auth");
    const paths = new Set(Object.values(getAuth().api as Record<string, { path?: string }>).map((endpoint) => endpoint.path));
    for (const path of [...PLACEHOLDER_GUARDED_ENDPOINTS, ...RECENT_SESSION_ENDPOINTS]) expect(paths.has(path), path).toBe(true);
  });

  it("connects Telegram to an email account through the confirmed redirect flow, preserving the account", async () => {
    const emailUser = await signInWithEmail("linker@example.com", "Linking Builder");
    const userId = emailUser.user.id;
    await state.pg!.query("INSERT INTO hq_account_capabilities (user_id, capability, reason) VALUES ($1, 'captain', 'fixture')", [userId]);
    await state.pg!.exec(`INSERT INTO hq_project_statuses(slug,label,color,counts_as_active,sort) VALUES('onboarding','Onboarding','accent',true,100);
      INSERT INTO hq_project_forecasts(slug,label,color,sort) VALUES('unassessed','Not assessed','muted',100);
      INSERT INTO hq_projects(id,hackathon_id,name,status_id,forecast_id,last_check_in)
        SELECT '11111111-1111-4111-8111-111111111111', 41, 'Fictional Team', s.id, f.id, current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f LIMIT 1`);
    await state.pg!.query("INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at) VALUES ('11111111-1111-4111-8111-111111111111','Linking Builder','linking_builder',$1,now())", [userId]);
    const before = await accountSnapshot(userId);
    expect(before.capabilities).toEqual([{ capability: "captain" }]);
    expect(before.teams).toBe(1);

    // Without the confirmation step the endpoint refuses and mints no OAuth state.
    const unconfirmed = await request("/link-social", LINK_BODY, emailUser.cookie);
    expect(unconfirmed.status).toBe(403);
    expect((await unconfirmed.json()).code).toBe("CONFIRMATION_REQUIRED");
    expect(cookieHeader(unconfirmed)).not.toContain("stnl_builder.state=");

    const callback = await linkTelegramTo(emailUser.cookie);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toMatch(/\/hq\/account\?connected=telegram$/);
    // Linking adds a login method; it does not sign anyone in.
    expect(sessionCookie(callback)).toBeNull();

    expect((await state.pg!.query('SELECT "providerId", issuer, "accountId", "userId" FROM hq_auth_account')).rows).toEqual([{ providerId: "telegram", issuer: ISSUER, accountId: SUB, userId }]);
    expect((await state.pg!.query("SELECT user_id, provider_subject, username FROM hq_auth_telegram_identity")).rows).toEqual([{ user_id: userId, provider_subject: SUB, username: USERNAME }]);
    expect((await state.pg!.query('SELECT id, email, "emailVerified" FROM hq_auth_user')).rows).toEqual([{ id: userId, email: "linker@example.com", emailVerified: true }]);
    expect(await auditEvents()).toEqual([identityEvent("identity.linked", userId)]);
    expect(await accountSnapshot(userId)).toEqual(before);

    // The confirmation was single use.
    const again = await request("/link-social", LINK_BODY, emailUser.cookie);
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe("TELEGRAM_ALREADY_CONNECTED");

    // Telegram sign-in now resolves to the very same account, with its real email.
    const telegram = await signInWithTelegram();
    expect(telegram.response.status).toBe(302);
    expect((await (await request("/get-session", undefined, telegram.session!.split(";")[0])).json()).user.id).toBe(userId);
    expect(await count("hq_auth_user")).toBe(1);
    expect(await count("hq_auth_account")).toBe(1);
    state.cookie = telegram.session!.split(";")[0];
    const { currentMember } = await import("@/lib/hq/member-auth");
    expect(await currentMember()).toEqual({ id: userId, email: "linker@example.com", name: "Linking Builder" });
    // A repeat sign-in is not a new link.
    expect(await auditEvents()).toEqual([identityEvent("identity.linked", userId)]);
    expect(await accountSnapshot(userId)).toEqual(before);
  });

  it("refuses a link whose confirmation is missing, expired, for the other action or already used, and a failed link grants nothing", async () => {
    const emailUser = await signInWithEmail("careful@example.com");
    const userId = emailUser.user.id;
    const store = await intentStore();
    const intents = () => state.pg!.query("SELECT value FROM hq_auth_verification WHERE identifier = $1", [`hq-telegram-intent:${userId}`]).then((r) => r.rows);
    const refused = async (label: string) => {
      const response = await request("/link-social", LINK_BODY, emailUser.cookie);
      expect(response.status, label).toBe(403);
      expect((await response.json()).code, label).toBe("CONFIRMATION_REQUIRED");
      expect(await intents(), label).toEqual([]);
    };

    await refused("never confirmed");
    await recordTelegramIntent(store, userId, "link");
    await state.pg!.query(`UPDATE hq_auth_verification SET "expiresAt" = now() - interval '1 minute' WHERE identifier = $1`, [`hq-telegram-intent:${userId}`]);
    await refused("expired");
    await recordTelegramIntent(store, userId, "unlink");
    await refused("confirmed the other action");
    await recordTelegramIntent(store, "someone-else", "link");
    await refused("confirmed by another account");

    // A valid confirmation opens exactly one attempt.
    await recordTelegramIntent(store, userId, "link");
    expect(await intents()).toEqual([{ value: "link" }]);
    const { response, start } = await startLink(emailUser.cookie);
    expect(response.status).toBe(200);
    expect(await intents()).toEqual([]);
    await refused("already used");

    // That attempt fails at the token exchange: nothing is linked, nothing is recorded, and the state cannot be replayed.
    state.tokenFailure = true;
    const failed = await completeCallback(start!);
    expect(failed.status).toBe(302);
    const location = new URL(failed.headers.get("location")!, ORIGIN);
    expect(location.pathname).toBe("/hq/account");
    expect(location.searchParams.getAll("error")).toEqual(["telegram", "invalid_code"]);
    state.tokenFailure = false;
    expect(errorCode(await completeCallback(start!))).toBe("state_mismatch");
    expect(await count("hq_auth_account")).toBe(0);
    expect(await count("hq_auth_telegram_identity")).toBe(0);
    expect(await auditEvents()).toEqual([]);
    expect(await count("hq_auth_session")).toBe(1);
  });

  it("refuses a second Telegram for an account, at the endpoint and inside the account transaction", async () => {
    const { session } = await signInWithTelegram();
    const cookie = session!.split(";")[0];
    state.cookie = cookie;
    const userId = (await state.pg!.query<{ id: string }>("SELECT id FROM hq_auth_user")).rows[0].id;
    const { confirmLinkTelegram } = await import("@/lib/hq/actions/telegram");
    expect(await confirmLinkTelegram()).toEqual({ ok: false, code: "TELEGRAM_ALREADY_CONNECTED" });

    // Even a recorded confirmation does not open a second link.
    const store = await intentStore();
    await recordTelegramIntent(store, userId, "link");
    const response = await request("/link-social", LINK_BODY, cookie);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("TELEGRAM_ALREADY_CONNECTED");
    expect(cookieHeader(response)).not.toContain("stnl_builder.state=");

    // The in-transaction backstop: a second telegram account row for the same user is refused before it exists.
    const otherSub = "5555555555555555555";
    const idToken = await mintIdToken({ sub: otherSub, id: 4_200_000_000_042, nonce: null });
    await expect(store.createAccount({ userId, providerId: "telegram", issuer: ISSUER, accountId: otherSub, idToken })).rejects.toMatchObject({ body: { code: "telegram_already_connected" } });
    expect((await state.pg!.query('SELECT "accountId" FROM hq_auth_account')).rows).toEqual([{ accountId: SUB }]);
    expect((await state.pg!.query("SELECT provider_subject FROM hq_auth_telegram_identity")).rows).toEqual([{ provider_subject: SUB }]);
    expect(await auditEvents()).toEqual([identityEvent("identity.linked", userId)]);
  });

  it("refuses to connect a Telegram account that belongs to another HQ account, moving nothing", async () => {
    const holder = await signInWithTelegram();
    const holderId = (await state.pg!.query<{ id: string }>("SELECT id FROM hq_auth_user")).rows[0].id;
    const emailUser = await signInWithEmail("second@example.com", "Second Builder");
    const before = { accounts: (await state.pg!.query("SELECT * FROM hq_auth_account ORDER BY id")).rows, identities: (await state.pg!.query("SELECT * FROM hq_auth_telegram_identity")).rows, audit: await auditEvents() };

    const callback = await linkTelegramTo(emailUser.cookie);
    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get("location")!, ORIGIN);
    expect(location.pathname).toBe("/hq/account");
    expect(location.searchParams.getAll("error")).toEqual(["telegram", "account_already_linked_to_different_user"]);
    expect(sessionCookie(callback)).toBeNull();

    expect((await state.pg!.query("SELECT * FROM hq_auth_account ORDER BY id")).rows).toEqual(before.accounts);
    expect((await state.pg!.query("SELECT * FROM hq_auth_telegram_identity")).rows).toEqual(before.identities);
    expect(await auditEvents()).toEqual(before.audit);
    expect((await state.pg!.query('SELECT id, email, "emailVerified" FROM hq_auth_user WHERE id = $1', [emailUser.user.id])).rows).toEqual([{ id: emailUser.user.id, email: "second@example.com", emailVerified: true }]);
    expect((await state.pg!.query("SELECT user_id FROM hq_auth_telegram_identity")).rows).toEqual([{ user_id: holderId }]);
    // The holder's session is untouched and still theirs.
    expect((await (await request("/get-session", undefined, holder.session!.split(";")[0])).json()).user.id).toBe(holderId);
  });

  it("requires a session created within 15 minutes on every endpoint that adds or removes a login method", async () => {
    const emailUser = await signInWithEmail("stale@example.com");
    const userId = emailUser.user.id;
    const store = await intentStore();
    state.cookie = emailUser.cookie;
    // A confirmation recorded while the session was fresh does not outlive the window.
    await recordTelegramIntent(store, userId, "link");
    await state.pg!.query(`UPDATE hq_auth_session SET "createdAt" = now() - interval '16 minutes'`);
    const sent = state.sent.length;

    const attempts: Array<[string, object]> = [
      ["/link-social", LINK_BODY],
      ["/unlink-account", { accountId: "any" }],
      ["/email-otp/request-email-change", { newEmail: "recover@example.com" }],
      ["/email-otp/change-email", { newEmail: "recover@example.com", otp: "000000" }],
      ["/change-email", { newEmail: "recover@example.com" }],
    ];
    for (const [path, body] of attempts) {
      const response = await request(path, body, emailUser.cookie);
      expect(response.status, path).toBe(403);
      expect((await response.json()).code, path).toBe("SESSION_NOT_FRESH");
    }
    const { confirmEmailChange, confirmLinkTelegram, confirmUnlinkTelegram } = await import("@/lib/hq/actions/telegram");
    expect(await confirmLinkTelegram()).toEqual({ ok: false, code: "SESSION_NOT_FRESH" });
    // Both confirmations answer the account's own state before the session's:
    // this account has no Telegram to disconnect and already signs in with an
    // email. The staleness they also enforce is asserted on a Telegram-only
    // account in "lets a stale session neither add an email nor..." below.
    expect(await confirmUnlinkTelegram()).toEqual({ ok: false, code: "TELEGRAM_NOT_CONNECTED" });
    expect(await confirmEmailChange("recover@example.com")).toEqual({ ok: false, code: "EMAIL_ALREADY_SET" });
    expect(state.sent).toHaveLength(sent);
    expect(await changeEmailRows()).toEqual([]);
    expect((await state.pg!.query('SELECT email, "emailVerified" FROM hq_auth_user')).rows).toEqual([{ email: "stale@example.com", emailVerified: true }]);
    expect(await count("hq_auth_account")).toBe(0);

    // Fourteen minutes is within the window; the recorded confirmation is still there to be consumed.
    await state.pg!.query(`UPDATE hq_auth_session SET "createdAt" = now() - interval '14 minutes'`);
    const { response } = await startLink(emailUser.cookie);
    expect(response.status).toBe(200);
    expect(cookieHeader(response)).toContain("stnl_builder.state=");

    // No session, the operator cookie, or another origin: never.
    expect((await request("/link-social", LINK_BODY)).status).toBe(401);
    expect((await request("/link-social", LINK_BODY, "hq_session=operator-cookie")).status).toBe(401);
    const crossOrigin = await route.POST(new Request(`${ORIGIN}/api/auth/link-social`, {
      method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json", Cookie: emailUser.cookie },
      body: JSON.stringify(LINK_BODY),
    }));
    expect(crossOrigin.status).toBe(403);
    expect(await count("hq_auth_account")).toBe(0);
  });

  it("never removes the last login method: a Telegram-only account cannot disconnect Telegram", async () => {
    const { session } = await signInWithTelegram();
    const cookie = session!.split(";")[0];
    state.cookie = cookie;
    const userId = (await state.pg!.query<{ id: string }>("SELECT id FROM hq_auth_user")).rows[0].id;
    const accountId = (await state.pg!.query<{ id: string }>("SELECT id FROM hq_auth_account")).rows[0].id;
    const { confirmUnlinkTelegram } = await import("@/lib/hq/actions/telegram");
    expect(await confirmUnlinkTelegram()).toEqual({ ok: false, code: "LAST_LOGIN_METHOD" });

    // Straight at the endpoint, even with a recorded confirmation: refused, and the confirmation is not spent.
    await recordTelegramIntent(await intentStore(), userId, "unlink");
    const response = await request("/unlink-account", { accountId }, cookie);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("LAST_LOGIN_METHOD");
    expect(await count("hq_auth_account")).toBe(1);
    expect(await count("hq_auth_telegram_identity")).toBe(1);
    expect(await auditEvents()).toEqual([identityEvent("identity.linked", userId)]);
    const { currentMember } = await import("@/lib/hq/member-auth");
    expect((await currentMember())?.id).toBe(userId);

    // The page agrees: the button is there, disabled, with the reason.
    const { default: AccountPage } = await import("@/app/hq/(member)/account/page");
    const html = renderToStaticMarkup(await AccountPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("cannot be disconnected");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Disconnect Telegram<\/button>/);
    expect(html).not.toContain('href="/hq/account/disconnect-telegram"');
  });

  it("disconnects Telegram after confirmation when a verified email remains, and records it", async () => {
    const emailUser = await signInWithEmail("keeps-email@example.com", "Keeps Email");
    const userId = emailUser.user.id;
    expect((await linkTelegramTo(emailUser.cookie)).status).toBe(302);
    const accountId = (await state.pg!.query<{ id: string }>("SELECT id FROM hq_auth_account")).rows[0].id;
    const before = await accountSnapshot(userId);

    const unconfirmed = await request("/unlink-account", { accountId }, emailUser.cookie);
    expect(unconfirmed.status).toBe(403);
    expect((await unconfirmed.json()).code).toBe("CONFIRMATION_REQUIRED");
    expect(await count("hq_auth_telegram_identity")).toBe(1);

    const { confirmUnlinkTelegram } = await import("@/lib/hq/actions/telegram");
    expect(await confirmUnlinkTelegram()).toEqual({ ok: true, accountId });
    const response = await request("/unlink-account", { accountId }, emailUser.cookie);
    expect(response.status).toBe(200);
    expect(await count("hq_auth_account")).toBe(0);
    expect(await count("hq_auth_telegram_identity")).toBe(0);
    expect(await auditEvents()).toEqual([identityEvent("identity.linked", userId), identityEvent("identity.unlinked", userId)]);
    expect(await accountSnapshot(userId)).toEqual(before);
    const { currentMember } = await import("@/lib/hq/member-auth");
    expect(await currentMember()).toEqual({ id: userId, email: "keeps-email@example.com", name: "Keeps Email" });

    // The link was removed, so the same Telegram identity now starts a new account of its own.
    const telegram = await signInWithTelegram();
    expect(telegram.response.status).toBe(302);
    expect(await count("hq_auth_user")).toBe(2);
    expect((await (await request("/get-session", undefined, telegram.session!.split(";")[0])).json()).user.id).not.toBe(userId);
  });

  it("refuses a stale Telegram identity when unlink cleanup fails after its provider account was deleted", async () => {
    const emailUser = await signInWithEmail("unlink-cleanup@example.com", "Unlink Cleanup");
    expect((await linkTelegramTo(emailUser.cookie)).status).toBe(302);
    const accountId = (await state.pg!.query<{ id: string }>("SELECT id FROM hq_auth_account")).rows[0].id;
    const { confirmUnlinkTelegram } = await import("@/lib/hq/actions/telegram");
    expect(await confirmUnlinkTelegram()).toEqual({ ok: true, accountId });
    await state.pg!.query("ALTER TABLE hq_audit_events ADD CONSTRAINT test_unlink_failure CHECK(kind <> 'identity.unlinked')");
    try {
      expect((await request("/unlink-account", { accountId }, emailUser.cookie)).status).toBe(200);
      expect(await count("hq_auth_account")).toBe(0);
      expect(await count("hq_auth_telegram_identity")).toBe(1);
      const { hasTelegramIdentity, findTelegramIdentityByTelegramUserId } = await import("@/lib/hq/identity");
      expect(await getTelegramIdentity(emailUser.user.id)).toBeNull();
      expect(await hasTelegramIdentity(emailUser.user.id)).toBe(false);
      expect(await findTelegramIdentityByTelegramUserId(String(TELEGRAM_ID))).toBeNull();
      const { telegramMemberActor } = await import("@/lib/hq/actor");
      expect(await telegramMemberActor(String(TELEGRAM_ID))).toBeNull();
    } finally {
      await state.pg!.query("ALTER TABLE hq_audit_events DROP CONSTRAINT test_unlink_failure");
    }
  });

  it("renders the account page from server data only, and ends a session whose identity row is missing", async () => {
    const telegram = await signInWithTelegram();
    const cookie = telegram.session!.split(";")[0];
    state.cookie = cookie;
    const { default: AccountPage } = await import("@/app/hq/(member)/account/page");
    const render = async (params: Record<string, string | string[]> = {}) => renderToStaticMarkup(await AccountPage({ searchParams: Promise.resolve(params) }));

    let html = await render();
    expect(html).toContain(`Connected as @${USERNAME}`);
    expect(html).toContain("None. This account signs in with Telegram only.");
    expect(html).not.toContain("placeholder.invalid");
    expect(html).not.toContain(SUB);
    expect(html).not.toContain(String(TELEGRAM_ID));
    expect(html).not.toMatch(/[—·]/);
    // Better Auth appends its code after ours; the page shows the specific one, and a cancel at Telegram is still explained.
    html = await render({ error: ["telegram", "account_already_linked_to_different_user"] });
    expect(html).toContain("already connected to another HQ account");
    expect(await render({ error: ["telegram", "access_denied"] })).toContain("We could not connect Telegram. Please try again.");
    expect(await render({ error: "access_denied" })).not.toContain("role=\"alert\"");
    expect(await render({ connected: "telegram" })).toContain("Telegram connected.");

    const emailUser = await signInWithEmail("page@example.com", "Page Builder");
    state.cookie = emailUser.cookie;
    html = await render();
    expect(html).toContain("page@example.com");
    expect(html).toContain("Not connected");
    expect(html).toContain('href="/hq/account/connect-telegram"');
    expect(html).not.toContain("placeholder.invalid");

    // The identity row never landed: the page ends the session and says why; the next Telegram sign-in repairs the row.
    state.cookie = cookie;
    await state.pg!.exec("DELETE FROM hq_auth_telegram_identity");
    await expect(AccountPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("REDIRECT:/hq/login?error=identity_missing&next=%2Fhq%2Faccount");
    expect(await (await request("/get-session", undefined, cookie)).json()).toBeNull();
    expect(await count("hq_auth_session")).toBe(1);
    const repaired = await signInWithTelegram();
    expect(await count("hq_auth_telegram_identity")).toBe(1);
    expect(await count("hq_auth_user")).toBe(2);
    // The confirmation actions fail the same way.
    state.cookie = repaired.session!.split(";")[0];
    await state.pg!.exec("DELETE FROM hq_auth_telegram_identity");
    const { confirmLinkTelegram } = await import("@/lib/hq/actions/telegram");
    await expect(confirmLinkTelegram()).rejects.toThrow("REDIRECT:/hq/login?error=identity_missing&next=%2Fhq%2Faccount%2Fconnect-telegram");
    expect(await (await request("/get-session", undefined, state.cookie)).json()).toBeNull();
  });

  it("takes a Telegram-first account through the name step without asking for an email", async () => {
    state.tokenOverride = { name: null };
    const start = await startSignIn({ newUserCallbackURL: "/hq/profile?next=%2Fhq%2Fwelcome" });
    const response = await completeCallback(start);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(/\/hq\/profile\?next=%2Fhq%2Fwelcome$/);
    const cookie = sessionCookie(response)!.split(";")[0];
    state.cookie = cookie;
    expect((await state.pg!.query("SELECT name FROM hq_auth_user")).rows).toEqual([{ name: "" }]);

    const { requireMember } = await import("@/lib/hq/member-auth");
    await expect(requireMember("/hq/welcome")).rejects.toThrow("REDIRECT:/hq/profile?next=%2Fhq%2Fwelcome");
    const { default: ProfilePage } = await import("@/app/hq/(member)/profile/page");
    const html = renderToStaticMarkup(await ProfilePage({ searchParams: Promise.resolve({ next: "/hq/welcome" }) }));
    expect(html).toContain('name="name"');
    expect(html).not.toContain('type="email"');
    expect(html).not.toContain("placeholder.invalid");
    // A Telegram account can be messaged, so the bot box is offered, ticked; the brand is plain text here.
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*name="botAllowed"[^>]*checked=""/);
    expect(html).toContain("Allow the Superteam NL bot to reach you on Telegram for reminders");
    expect(html).toContain("Superteam NL");
    expect(html).not.toContain("superteam NL");
    expect(html).not.toMatch(/<a[^>]*href="\/"/);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toMatch(/[—·]/);

    const { completeMemberProfile } = await import("@/app/hq/(member)/profile/actions");
    const form = new FormData();
    form.set("name", "Named Builder");
    form.set("next", "/hq/welcome");
    form.set("botAllowed", "on");
    await expect(completeMemberProfile(null, form)).rejects.toThrow("REDIRECT:/hq/welcome");
    expect((await state.pg!.query("SELECT name FROM hq_auth_user")).rows).toEqual([{ name: "Named Builder" }]);
    expect((await state.pg!.query("SELECT email, name FROM hq_builder_profiles")).rows).toEqual([{ email: null, name: "Named Builder" }]);
    expect(state.synced).toHaveBeenCalledWith({ id: expect.any(String), email: null, name: "Named Builder" });
    expect(state.sent).toEqual([]);
    expect((await requireMember("/hq/welcome")).name).toBe("Named Builder");
    // The ticked box is the consent the bot needs, recorded for this Telegram account with its audit event.
    const userId = (await state.pg!.query<{ id: string }>("SELECT id FROM hq_auth_user")).rows[0].id;
    expect(await getBotConsent(userId)).toMatchObject({ userId, telegramUserId: String(TELEGRAM_ID), messagingEnabled: true, revokedAt: null });
    expect(await auditEvents()).toEqual([identityEvent("identity.linked", userId), memberEvent("bot.consent_changed", userId, { enabled: true })]);
  });

  it("stays stale through the library's own session refresh", async () => {
    const emailUser = await signInWithEmail("refreshed@example.com");
    const userId = emailUser.user.id;
    await recordTelegramIntent(await intentStore(), userId, "link");
    // Old enough to be stale, and close enough to expiry for /get-session to extend it (session.mjs shouldBeUpdated).
    await state.pg!.query(`UPDATE hq_auth_session SET "createdAt" = now() - interval '16 minutes', "updatedAt" = now() - interval '16 minutes', "expiresAt" = now() + interval '28 days'`);
    const before = (await state.pg!.query<{ createdAt: Date; updatedAt: Date; expiresAt: Date }>('SELECT "createdAt", "updatedAt", "expiresAt" FROM hq_auth_session')).rows[0];

    const session = await request("/get-session", undefined, emailUser.cookie);
    expect((await session.json()).user.id).toBe(userId);
    const after = (await state.pg!.query<{ createdAt: Date; updatedAt: Date; expiresAt: Date }>('SELECT "createdAt", "updatedAt", "expiresAt" FROM hq_auth_session')).rows[0];
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(after.expiresAt.getTime()).toBeGreaterThan(before.expiresAt.getTime());
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());

    const link = await request("/link-social", LINK_BODY, emailUser.cookie);
    expect(link.status).toBe(403);
    expect((await link.json()).code).toBe("SESSION_NOT_FRESH");
    expect(cookieHeader(link)).not.toContain("stnl_builder.state=");
  });

  it("does not expose the stored provider tokens to the session holder", async () => {
    const { session } = await signInWithTelegram();
    const cookie = session!.split(";")[0];
    const accountId = (await state.pg!.query<{ id: string }>("SELECT id FROM hq_auth_account")).rows[0].id;
    for (const [path, body] of [["/get-access-token", { accountId }], ["/refresh-token", { accountId }], [`/account-info?accountId=${accountId}`, undefined]] as const) {
      const response = await request(path, body, cookie);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).not.toContain(state.minted.at(-1)!);
    }
    // The endpoints the flow needs are still there.
    expect((await request("/list-accounts", undefined, cookie)).status).toBe(200);
  });

  it("never hands the placeholder address to a browser through /get-session", async () => {
    const telegram = await signInWithTelegram();
    const cookie = telegram.session!.split(";")[0];
    const userId = (await state.pg!.query<{ id: string }>("SELECT id FROM hq_auth_user")).rows[0].id;

    const response = await request("/get-session", undefined, cookie);
    const body = await response.text();
    expect(body).not.toContain("placeholder.invalid");
    expect(body).not.toContain(SUB);
    const payload = JSON.parse(body) as { user: { id: string; email: string | null; emailVerified: boolean; name: string }; session: { token: string; userId: string } };
    expect(payload.user).toMatchObject({ id: userId, email: null, emailVerified: false, name: NAME });
    // The row itself is untouched: Better Auth still needs a string email.
    expect((await state.pg!.query('SELECT email, "emailVerified" FROM hq_auth_user')).rows).toEqual([{ email: PLACEHOLDER, emailVerified: false }]);
    // And the session half is still whole, so the transform breaks no caller.
    expect(payload.session).toMatchObject({ userId });
    expect(payload.session.token).toEqual(expect.any(String));

    // A real verified address still comes back as itself.
    const emailUser = await signInWithEmail("visible@example.com", "Email Builder");
    const shown = await (await request("/get-session", undefined, emailUser.cookie)).json();
    expect(shown.user).toMatchObject({ id: emailUser.user.id, email: "visible@example.com", emailVerified: true });
  });

  it("adds a verified recovery email to a Telegram-first account, mailing the new address once and nobody else", async () => {
    const { session } = await signInWithTelegram();
    const cookie = session!.split(";")[0];
    state.cookie = cookie;
    const userId = (await state.pg!.query<{ id: string }>("SELECT id FROM hq_auth_user")).rows[0].id;
    const { confirmEmailChange, confirmUnlinkTelegram } = await import("@/lib/hq/actions/telegram");

    // Without the confirmation step the endpoint refuses, mails nothing and stores nothing.
    const unconfirmed = await request("/email-otp/request-email-change", { newEmail: "recover@example.com" }, cookie);
    expect(unconfirmed.status).toBe(403);
    expect((await unconfirmed.json()).code).toBe("CONFIRMATION_REQUIRED");
    expect(state.sent).toEqual([]);
    expect(await changeEmailRows()).toEqual([]);

    // A confirmation names one address and is spent on the first request, matching or not.
    expect(await confirmEmailChange(" Recover@Example.com ")).toEqual({ ok: true, newEmail: "recover@example.com" });
    expect(await intents(userId)).toEqual([{ value: "change-email:recover@example.com" }]);
    const other = await request("/email-otp/request-email-change", { newEmail: "someone-else@example.com" }, cookie);
    expect(other.status).toBe(403);
    expect((await other.json()).code).toBe("CONFIRMATION_REQUIRED");
    expect(await intents(userId)).toEqual([]);
    expect(state.sent).toEqual([]);

    expect(await confirmEmailChange("recover@example.com")).toEqual({ ok: true, newEmail: "recover@example.com" });
    const requested = await request("/email-otp/request-email-change", { newEmail: "recover@example.com" }, cookie);
    expect(requested.status).toBe(200);
    expect(await requested.json()).toEqual({ success: true });
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].to).toBe("recover@example.com");
    expect(state.sent[0].text).toContain("confirm this address");
    expect(state.sent[0].text).toContain("It expires in 15 minutes.");
    const otp = state.sent[0].text.match(/\b\d{6}\b/)![0];
    expect(state.sent[0].html).toContain(otp);
    expect(state.sent[0].html).toContain("cid:superteam-nl-logo");
    expect(state.sent[0].attachments).toEqual([expect.objectContaining({contentId:"superteam-nl-logo",contentType:"image/png"})]);
    const again = await request("/email-otp/request-email-change", { newEmail: "recover@example.com" }, cookie);
    expect(again.status).toBe(403);

    // The code is checked with the plugin's attempt budget; the right one flips the account to a verified real address, same id.
    const wrong = await request("/email-otp/change-email", { newEmail: "recover@example.com", otp: otp === "000000" ? "111111" : "000000" }, cookie);
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).code).toBe("INVALID_OTP");
    const changed = await request("/email-otp/change-email", { newEmail: "recover@example.com", otp }, cookie);
    expect(changed.status).toBe(200);
    expect((await state.pg!.query('SELECT id, email, "emailVerified" FROM hq_auth_user')).rows).toEqual([{ id: userId, email: "recover@example.com", emailVerified: true }]);
    // There was no previous real address, so nothing else was sent, and the audit says so.
    expect(state.sent).toHaveLength(1);
    expect(await auditEvents()).toEqual([identityEvent("identity.linked", userId), memberEvent("identity.email_changed", userId, { hadPreviousEmail: false })]);
    expect((await state.pg!.query("SELECT email FROM hq_builder_profiles")).rows).toEqual([{ email: "recover@example.com" }]);
    expect(await changeEmailRows()).toEqual([]);

    const { currentMember } = await import("@/lib/hq/member-auth");
    expect(await currentMember()).toEqual({ id: userId, email: "recover@example.com", name: NAME });
    // The account now signs in with an email, so the same action will not move it.
    expect(await confirmEmailChange("second@example.com")).toEqual({ ok: false, code: "EMAIL_ALREADY_SET" });
    expect(await intents(userId)).toEqual([]);
    const { default: AccountPage } = await import("@/app/hq/(member)/account/page");
    const html = renderToStaticMarkup(await AccountPage({ searchParams: Promise.resolve({ email: "added" }) }));
    expect(html).toContain("recover@example.com");
    expect(html).toContain("Email added.");
    expect(html).toContain('href="/hq/account/disconnect-telegram"');
    expect(html).not.toContain('href="/hq/account/add-email"');
    expect(html).not.toContain("placeholder.invalid");

    // The new address signs in to the very same account.
    const byEmail = await signInWithEmail("recover@example.com", NAME);
    expect(byEmail.user.id).toBe(userId);
    expect(await count("hq_auth_user")).toBe(1);

    // With a verified email in place Telegram may go, and the identity row goes with it.
    state.cookie = cookie;
    const accountId = (await state.pg!.query<{ id: string }>("SELECT id FROM hq_auth_account")).rows[0].id;
    expect(await confirmUnlinkTelegram()).toEqual({ ok: true, accountId });
    expect((await request("/unlink-account", { accountId }, cookie)).status).toBe(200);
    expect(await count("hq_auth_account")).toBe(0);
    expect(await count("hq_auth_telegram_identity")).toBe(0);
    expect(await currentMember()).toEqual({ id: userId, email: "recover@example.com", name: NAME });
  });

  it("refuses to move the login email of an account that already signs in with one", async () => {
    const emailUser = await signInWithEmail("holder@example.com", "Settled Builder");
    state.cookie = emailUser.cookie;
    state.sent.length = 0;
    const { confirmEmailChange } = await import("@/lib/hq/actions/telegram");

    // A session minutes old passes every other check the action makes: only
    // the account already having a login email stops it. The page redirects
    // such an account away, but an action is directly callable.
    expect(await confirmEmailChange("attacker@example.com")).toEqual({ ok: false, code: "EMAIL_ALREADY_SET" });
    expect(await intents(emailUser.user.id)).toEqual([]);
    expect(state.sent).toEqual([]);
    // And with no intent recorded the endpoint refuses too, so nothing moved.
    const requested = await request("/email-otp/request-email-change", { newEmail: "attacker@example.com" }, emailUser.cookie);
    expect(requested.status).toBe(403);
    expect((await requested.json()).code).toBe("CONFIRMATION_REQUIRED");
    expect(await changeEmailRows()).toEqual([]);
    expect((await state.pg!.query("SELECT email FROM hq_auth_user")).rows).toEqual([{ email: "holder@example.com" }]);
  });

  it("tells the previous verified address, once, when the login email changes", async () => {
    const emailUser = await signInWithEmail("before@example.com", "Moving Builder");
    const userId = emailUser.user.id;
    state.cookie = emailUser.cookie;
    state.sent.length = 0;
    // No page or action moves a login email that already exists, so the
    // intent the endpoint requires is written directly to reach the hook.
    await recordTelegramIntent(await intentStore(), userId, "change-email", "after@example.com");
    const changed = await changeEmailWithCode(emailUser.cookie, "after@example.com");
    expect(changed.status).toBe(200);
    // Exactly two messages: the code to the new address, then the notice to the old one, which carries no code.
    expect(state.sent.map((message) => message.to)).toEqual(["after@example.com", "before@example.com"]);
    // The notice names neither the new address (whoever still reads the old mailbox must not learn it) nor a code.
    expect(state.sent[1].subject).toContain("email changed");
    expect(state.sent[1].text).toContain("contact Superteam NL");
    expect(state.sent[1].text).not.toContain("after@example.com");
    expect(state.sent[1].text).not.toMatch(/\b\d{6}\b/);
    expect(state.sent[1].html).toBeUndefined();
    expect(state.sent[1].attachments).toBeUndefined();
    expect((await state.pg!.query('SELECT id, email, "emailVerified" FROM hq_auth_user')).rows).toEqual([{ id: userId, email: "after@example.com", emailVerified: true }]);
    expect(await auditEvents()).toEqual([memberEvent("identity.email_changed", userId, { hadPreviousEmail: true })]);
    expect((await state.pg!.query("SELECT email FROM hq_builder_profiles")).rows).toEqual([{ email: "after@example.com" }]);
    const { currentMember } = await import("@/lib/hq/member-auth");
    expect(await currentMember()).toEqual({ id: userId, email: "after@example.com", name: "Moving Builder" });
  });

  it("answers a request for an address another account holds exactly like one for a free address, sending nothing to it", async () => {
    await signInWithEmail("taken@example.com", "Holder");
    const { session } = await signInWithTelegram();
    const cookie = session!.split(";")[0];
    state.cookie = cookie;
    const { confirmEmailChange } = await import("@/lib/hq/actions/telegram");
    state.sent.length = 0;

    expect(await confirmEmailChange("taken@example.com")).toEqual({ ok: true, newEmail: "taken@example.com" });
    const taken = await request("/email-otp/request-email-change", { newEmail: "taken@example.com" }, cookie);
    expect(await confirmEmailChange("free@example.com")).toEqual({ ok: true, newEmail: "free@example.com" });
    const free = await request("/email-otp/request-email-change", { newEmail: "free@example.com" }, cookie);
    expect([taken.status, free.status]).toEqual([200, 200]);
    expect(await taken.json()).toEqual(await free.json());
    expect(state.sent.map((message) => message.to)).toEqual(["free@example.com"]);
    expect((await state.pg!.query("SELECT identifier FROM hq_auth_verification WHERE identifier ILIKE '%taken@example.com%'")).rows).toEqual([]);
    // Nothing to guess: no code exists for the taken address, and the holder's account is untouched.
    const guess = await request("/email-otp/change-email", { newEmail: "taken@example.com", otp: "000000" }, cookie);
    expect(guess.status).toBe(400);
    expect((await state.pg!.query("SELECT email FROM hq_auth_user ORDER BY email")).rows).toEqual([{ email: PLACEHOLDER }, { email: "taken@example.com" }]);
  });

  it("answers a failed code for an address another account holds exactly like one for a free address, whatever the attempt or the code's age", async () => {
    await signInWithEmail("taken@example.com", "Holder");
    const { session } = await signInWithTelegram();
    const cookie = session!.split(";")[0];
    state.cookie = cookie;
    state.sent.length = 0;
    const { confirmEmailChange } = await import("@/lib/hq/actions/telegram");
    const requestCode = async (newEmail: string) => {
      expect(await confirmEmailChange(newEmail)).toEqual({ ok: true, newEmail });
      expect((await request("/email-otp/request-email-change", { newEmail }, cookie)).status).toBe(200);
    };
    // What a caller can compare: status, reason phrase, content type and body.
    const guess = async (newEmail: string, otp: string) => {
      const response = await request("/email-otp/change-email", { newEmail, otp }, cookie);
      return { status: response.status, statusText: response.statusText, type: response.headers.get("content-type"), body: await response.json() };
    };
    await requestCode("taken@example.com");
    await requestCode("free@example.com");
    expect(state.sent.map((message) => message.to)).toEqual(["free@example.com"]);
    const code = state.sent[0].text.match(/\b\d{6}\b/)![0];
    const wrong = code === "000000" ? "111111" : "000000";

    // Five guesses each: three inside the budget, one past it (the library's TOO_MANY_ATTEMPTS), one with no row left.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const taken = await guess("taken@example.com", wrong);
      expect(taken.status, `attempt ${attempt}`).toBe(400);
      expect(taken.body.code, `attempt ${attempt}`).toBe("INVALID_OTP");
      expect(await guess("free@example.com", wrong), `attempt ${attempt}`).toEqual(taken);
    }
    // The budget itself still holds: the right code is dead after three wrong ones.
    expect((await guess("free@example.com", code)).body.code).toBe("INVALID_OTP");
    expect(await changeEmailRows()).toEqual([]);

    // A code past its fifteen minutes (the library's OTP_EXPIRED) answers the same as no code at all.
    await requestCode("expired@example.com");
    await state.pg!.query(`UPDATE hq_auth_verification SET "expiresAt" = now() - interval '1 minute' WHERE identifier LIKE 'change-email-otp-%'`);
    expect(await guess("expired@example.com", wrong)).toEqual(await guess("taken@example.com", wrong));
    expect(await changeEmailRows()).toEqual([]);
    expect((await state.pg!.query("SELECT email FROM hq_auth_user ORDER BY email")).rows).toEqual([{ email: PLACEHOLDER }, { email: "taken@example.com" }]);
  });

  it("lets a stale session neither add an email nor use one to disconnect Telegram", async () => {
    const { session } = await signInWithTelegram();
    const cookie = session!.split(";")[0];
    state.cookie = cookie;
    const userId = (await state.pg!.query<{ id: string }>("SELECT id FROM hq_auth_user")).rows[0].id;
    const accountId = (await state.pg!.query<{ id: string }>("SELECT id FROM hq_auth_account")).rows[0].id;
    const store = await intentStore();
    const { confirmEmailChange, confirmUnlinkTelegram } = await import("@/lib/hq/actions/telegram");
    await state.pg!.query(`UPDATE hq_auth_session SET "createdAt" = now() - interval '16 minutes'`);

    expect(await confirmEmailChange("recover@example.com")).toEqual({ ok: false, code: "SESSION_NOT_FRESH" });
    // Even a confirmation written directly opens nothing for a stale session, on any of the three routes.
    await recordTelegramIntent(store, userId, "change-email", "recover@example.com");
    const attempts: Array<[string, object]> = [
      ["/email-otp/request-email-change", { newEmail: "recover@example.com" }],
      ["/email-otp/change-email", { newEmail: "recover@example.com", otp: "000000" }],
      ["/change-email", { newEmail: "recover@example.com" }],
    ];
    for (const [path, body] of attempts) {
      const response = await request(path, body, cookie);
      expect(response.status, path).toBe(403);
      expect((await response.json()).code, path).toBe("SESSION_NOT_FRESH");
    }
    expect(state.sent).toEqual([]);
    expect(await changeEmailRows()).toEqual([]);
    expect((await state.pg!.query('SELECT email, "emailVerified" FROM hq_auth_user')).rows).toEqual([{ email: PLACEHOLDER, emailVerified: false }]);

    // So Telegram is still the only way in and stays: the action says stale, then last method; the endpoint refuses even with an unlink intent written directly.
    expect(await confirmUnlinkTelegram()).toEqual({ ok: false, code: "SESSION_NOT_FRESH" });
    await state.pg!.query(`UPDATE hq_auth_session SET "createdAt" = now() - interval '14 minutes'`);
    expect(await confirmUnlinkTelegram()).toEqual({ ok: false, code: "LAST_LOGIN_METHOD" });
    await recordTelegramIntent(store, userId, "unlink");
    const unlink = await request("/unlink-account", { accountId }, cookie);
    expect(unlink.status).toBe(400);
    expect((await unlink.json()).code).toBe("LAST_LOGIN_METHOD");
    expect(await count("hq_auth_account")).toBe(1);
    expect(await count("hq_auth_telegram_identity")).toBe(1);
  });

  it("keeps the core change-email route disabled", async () => {
    const emailUser = await signInWithEmail("core@example.com");
    const response = await request("/change-email", { newEmail: "other@example.com" }, emailUser.cookie);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("CHANGE_EMAIL_DISABLED");
    expect(state.sent).toHaveLength(1);
    expect((await state.pg!.query("SELECT email FROM hq_auth_user")).rows).toEqual([{ email: "core@example.com" }]);
  });

  it("keeps the core delete-user route disabled", async () => {
    const emailUser = await signInWithEmail("stays@example.com");
    // `user.deleteUser` is unset, so the route answers 404 before reading the session (update-user.mjs).
    const response = await request("/delete-user", {}, emailUser.cookie);
    expect(response.status).toBe(404);
    expect(await count("hq_auth_user")).toBe(1);
    expect(await count("hq_auth_session")).toBe(1);
    expect((await (await request("/get-session", undefined, emailUser.cookie)).json()).user.id).toBe(emailUser.user.id);
    expect(state.sent).toHaveLength(1);
  });

  it("keeps bot messages a separate decision from the Telegram connection, and declining changes nothing about access", async () => {
    const { session } = await signInWithTelegram();
    const cookie = session!.split(";")[0];
    state.cookie = cookie;
    const userId = (await state.pg!.query<{ id: string }>("SELECT id FROM hq_auth_user")).rows[0].id;
    const { setBotMessaging } = await import("@/lib/hq/actions/telegram");
    const { currentMember, requireMember } = await import("@/lib/hq/member-auth");
    const { default: AccountPage } = await import("@/app/hq/(member)/account/page");
    const render = async () => renderToStaticMarkup(await AccountPage({ searchParams: Promise.resolve({}) }));
    const consentRows = () => state.pg!.query(
      "SELECT user_id, telegram_user_id::text AS telegram_user_id, messaging_enabled, consented_at IS NOT NULL AS consented, revoked_at IS NOT NULL AS revoked FROM hq_telegram_bot_consent",
    ).then((r) => r.rows);

    // Connected is not consent: no row, and the page says so next to the connection.
    expect(await getBotConsent(userId)).toBeNull();
    let html = await render();
    expect(html).toContain("Bot messages");
    expect(html).toMatch(/>Disabled<\/span>/);
    expect(html).toContain("Enable bot messages");
    expect(html).toContain("only when this is enabled");
    expect(html).toContain("website access is the same either way");
    expect(html).not.toMatch(/[—·]/);

    expect(await setBotMessaging(true)).toEqual({ ok: true, enabled: true });
    expect(await consentRows()).toEqual([{ user_id: userId, telegram_user_id: String(TELEGRAM_ID), messaging_enabled: true, consented: true, revoked: false }]);
    expect(await getBotConsent(userId)).toMatchObject({ userId, telegramUserId: String(TELEGRAM_ID), messagingEnabled: true, revokedAt: null });
    html = await render();
    expect(html).toMatch(/>Enabled<\/span>/);
    expect(html).toContain("Disable bot messages");
    // Saying it again records nothing; declining records once and keeps the website.
    expect(await setBotMessaging(true)).toEqual({ ok: true, enabled: true });
    expect(await setBotMessaging(false)).toEqual({ ok: true, enabled: false });
    expect(await consentRows()).toEqual([{ user_id: userId, telegram_user_id: String(TELEGRAM_ID), messaging_enabled: false, consented: true, revoked: true }]);
    expect(await setBotMessaging(false)).toEqual({ ok: true, enabled: false });
    expect(await auditEvents()).toEqual([
      identityEvent("identity.linked", userId),
      memberEvent("bot.consent_changed", userId, { enabled: true }),
      memberEvent("bot.consent_changed", userId, { enabled: false }),
    ]);
    expect(await currentMember()).toEqual({ id: userId, email: null, name: NAME });
    expect((await requireMember("/hq/account")).id).toBe(userId);
    expect(await count("hq_auth_telegram_identity")).toBe(1);
    expect(await count("hq_auth_session")).toBe(1);
    expect(await render()).toMatch(/>Disabled<\/span>/);

    // No Telegram, nobody to message: the action refuses, nothing is written, and the page has no such section.
    const emailUser = await signInWithEmail("no-telegram@example.com", "Email Only");
    state.cookie = emailUser.cookie;
    expect(await setBotMessaging(true)).toEqual({ ok: false, code: "TELEGRAM_NOT_CONNECTED" });
    expect(await getBotConsent(emailUser.user.id)).toBeNull();
    expect(await count("hq_telegram_bot_consent")).toBe(1);
    expect(await render()).not.toContain("Bot messages");
  });

  it("revokes bot messages when Telegram is disconnected, in the same operation", async () => {
    const emailUser = await signInWithEmail("keeps-email-too@example.com", "Keeps Email");
    const userId = emailUser.user.id;
    expect((await linkTelegramTo(emailUser.cookie)).status).toBe(302);
    state.cookie = emailUser.cookie;
    const { confirmUnlinkTelegram, setBotMessaging } = await import("@/lib/hq/actions/telegram");
    expect(await setBotMessaging(true)).toEqual({ ok: true, enabled: true });
    const accountId = (await state.pg!.query<{ id: string }>("SELECT id FROM hq_auth_account")).rows[0].id;

    expect(await confirmUnlinkTelegram()).toEqual({ ok: true, accountId });
    expect((await request("/unlink-account", { accountId }, emailUser.cookie)).status).toBe(200);
    expect(await count("hq_auth_telegram_identity")).toBe(0);
    expect(await getBotConsent(userId)).toMatchObject({ messagingEnabled: false, revokedAt: expect.any(String) });
    expect(await auditEvents()).toEqual([
      identityEvent("identity.linked", userId),
      memberEvent("bot.consent_changed", userId, { enabled: true }),
      identityEvent("identity.unlinked", userId),
      memberEvent("bot.consent_changed", userId, { enabled: false, cause: "telegram_disconnected" }),
    ]);
    const { currentMember } = await import("@/lib/hq/member-auth");
    expect(await currentMember()).toEqual({ id: userId, email: "keeps-email-too@example.com", name: "Keeps Email" });

    // Connecting again does not bring it back.
    expect((await linkTelegramTo(emailUser.cookie)).status).toBe(302);
    expect(await getBotConsent(userId)).toMatchObject({ messagingEnabled: false });
    expect((await auditEvents()).slice(4)).toEqual([identityEvent("identity.linked", userId)]);
  });

  it("renders the recovery-email step for a Telegram-only account and sends an account with an email back", async () => {
    const { session } = await signInWithTelegram();
    state.cookie = session!.split(";")[0];
    const { default: AddEmailPage } = await import("@/app/hq/(member)/account/add-email/page");
    const { default: AccountPage } = await import("@/app/hq/(member)/account/page");
    const html = renderToStaticMarkup(await AddEmailPage());
    expect(html).toContain("Add a recovery");
    expect(html).toContain('name="email"');
    expect(html).toContain("Send code");
    expect(html).toContain("within 15 minutes");
    expect(html).not.toContain("placeholder.invalid");
    expect(html).not.toMatch(/[—·]/);
    const account = renderToStaticMarkup(await AccountPage({ searchParams: Promise.resolve({}) }));
    expect(account).toContain('href="/hq/account/add-email"');
    expect(account).toContain("Add a recovery email");

    const emailUser = await signInWithEmail("has-email@example.com", "Has Email");
    state.cookie = emailUser.cookie;
    await expect(AddEmailPage()).rejects.toThrow("REDIRECT:/hq/account");
  });

  it("lets the database refuse a second Telegram account row even when the identity backstop cannot see it", async () => {
    const { session } = await signInWithTelegram();
    state.cookie = session!.split(";")[0];
    const userId = (await state.pg!.query<{ id: string }>("SELECT id FROM hq_auth_user")).rows[0].id;
    // The race the unique index is for: the identity row is not there, so account.create.before finds nothing to refuse.
    await state.pg!.exec("DELETE FROM hq_auth_telegram_identity");
    const otherSub = "5555555555555555555";
    const idToken = await mintIdToken({ sub: otherSub, id: 4_200_000_000_042, nonce: null });
    const store = await intentStore();
    await expect(store.createAccount({ userId, providerId: "telegram", issuer: ISSUER, accountId: otherSub, idToken })).rejects.toThrow(/hq_auth_account_telegram_user_idx|unique/i);
    expect((await state.pg!.query('SELECT "accountId" FROM hq_auth_account')).rows).toEqual([{ accountId: SUB }]);
    expect(await count("hq_auth_telegram_identity")).toBe(0);
    expect(await auditEvents()).toEqual([identityEvent("identity.linked", userId)]);
  });
});

describe("Telegram profile id normalization", () => {
  const claims = { iss: ISSUER, aud: CLIENT_ID, sub: SUB, iat: 1_700_000_000, exp: 1_700_003_600 };

  it.each([1, TELEGRAM_ID, Number.MAX_SAFE_INTEGER])("preserves numeric id %s and its decimal string without changing the OIDC subject", (id) => {
    for (const value of [id, String(id)]) {
      expect(parseTelegramClaims({ ...claims, id: value })).toMatchObject({ id, sub: SUB });
    }
  });

  it.each([
    ["missing", undefined], ["null", null], ["boolean", true], ["object", {}], ["array", [TELEGRAM_ID]],
    ["empty string", ""], ["zero", 0], ["string zero", "0"], ["negative", -1], ["string negative", "-1"],
    ["fraction", 1.5], ["string fraction", "1.5"], ["exponent", "1e3"], ["explicit sign", "+123"],
    ["leading space", " 123"], ["trailing space", "123 "], ["leading zero", "0123"],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1], ["unsafe integer string", "9007199254740992"],
    ["very long integer", "9".repeat(100)], ["NaN", Number.NaN], ["infinity", Number.POSITIVE_INFINITY],
  ])("refuses %s without using the OIDC subject as the Telegram user id", (_label, id) => {
    const parsed = parseTelegramClaims({ ...claims, id });
    expect(parsed?.id).toBeUndefined();
    expect(parsed?.sub).toBe(SUB);
  });
});
