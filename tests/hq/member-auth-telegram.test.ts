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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "./helpers/db";
import { getTelegramIdentity } from "@/lib/hq/identity";
import { hqTelegramIdentity } from "@/lib/hq/telegram-identity-plugin";
import { TELEGRAM_ISSUER, TELEGRAM_REJECTION_LOG_PREFIX, telegramProvider } from "@/lib/hq/telegram-provider";

const state = vi.hoisted(() => ({
  pg: null as PGlite | null,
  sent: [] as Array<{ to: string; text: string }>,
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
vi.mock("next/headers", () => ({ headers: async () => new Headers({ Origin: "https://hq-test.example", Cookie: state.cookie }) }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));
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
      send: async (message: { to: string; text: string }) => {
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
  sub?: string; id?: number | null; nonce?: string | null; iss?: string; aud?: string;
  iat?: number; exp?: number | string; key?: CryptoKey; kid?: string;
};

async function mintIdToken(o: TokenOverride = {}) {
  const payload: Record<string, unknown> = { name: NAME, preferred_username: USERNAME, picture: PICTURE };
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
  const response = await request("/sign-in/social", { provider: "telegram", callbackURL: "/hq/welcome", errorCallbackURL: "/hq/signin", disableRedirect: true, ...extra });
  expect(response.status).toBe(200);
  const url = new URL((await response.json()).url);
  return { url, state: url.searchParams.get("state")!, nonce: url.searchParams.get("nonce")!, codeChallenge: url.searchParams.get("code_challenge")!, cookie: cookieHeader(response) };
}

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
    await state.pg!.exec("TRUNCATE hq_auth_user, hq_auth_verification, hq_auth_rate_limit, hq_builder_profiles, hq_hackathons CASCADE");
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
    expect(state.fetches).toEqual([]);
  });

  it("completes the callback into a verified HQ account that has no email", async () => {
    const { start, response, session } = await signInWithTelegram();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(/\/hq\/welcome$/);
    expect(session).toContain("HttpOnly");
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
    await expect(requireMember("/hq/welcome")).rejects.toThrow("REDIRECT:/hq/signin?error=identity_missing&next=%2Fhq%2Fwelcome");
    expect(await count("hq_auth_session")).toBe(0);
    expect(await (await request("/get-session", undefined, cookie)).json()).toBeNull();
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

    expect(state.sent).toEqual([]);
    expect(await verifications()).toEqual([]);
    expect(await count("hq_auth_account")).toBe(accounts);
    expect(await count("hq_auth_session")).toBe(1);

    // The database hook closes updateUser as well, which never runs validateUserInfo.
    const { getAuth } = await import("@/lib/hq/member-auth");
    const context = await getAuth().$context;
    const userId = (await state.pg!.query<{ id: string }>("SELECT id FROM hq_auth_user")).rows[0].id;
    await expect(context.internalAdapter.updateUser(userId, { email: "another@telegram.placeholder.invalid" })).rejects.toMatchObject({ body: { code: "placeholder_email_not_allowed" } });
    expect((await context.internalAdapter.updateUser(userId, { name: "Renamed Builder" }))?.name).toBe("Renamed Builder");
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
});
