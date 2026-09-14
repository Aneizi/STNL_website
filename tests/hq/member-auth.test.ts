import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { getIP } from "@better-auth/core/utils/ip";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pg: null as PGlite | null,
  sent: [] as Array<{ to: string; text: string }>,
  synced: vi.fn(),
  emailFailure: false,
  cookie: "",
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
        if (state.emailFailure) return { error: { message: "test sender failure" } };
        state.sent.push(message);
        return { error: null, data: { id: "test-email" } };
      },
    };
  },
}));

const ORIGIN = "https://hq-test.example";
let route: typeof import("@/app/api/auth/[...all]/route");
let ipNumber = 1;

function request(path: string, body?: object, cookie?: string, ip = `192.0.2.${ipNumber}`) {
  return route[body ? "POST" : "GET"](new Request(`${ORIGIN}/api/auth${path}`, {
    method: body ? "POST" : "GET",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", "x-real-ip": ip, ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
}

function latestCode() {
  return state.sent.at(-1)!.text.match(/\b\d{6}\b/)![0];
}

const SECRET = "test-only-independent-auth-secret-0123456789";

/**
 * The whole Set-Cookie line a member session must arrive with on an https
 * origin: the __Secure- prefix with the Secure attribute it requires,
 * HttpOnly, SameSite=Lax (the Telegram redirect is a top-level GET) and the
 * 30-day Max-Age; no Domain, so it never reaches another host.
 */
const SESSION_COOKIE_LINE = /^__Secure-stnl_builder\.session_token=[^;]+; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/;

/** A session token signed the way Better Auth signs its session cookie, for rows inserted directly. */
function signedSessionCookie(token: string) {
  const signature = createHmac("sha256", SECRET).update(token).digest("base64");
  return `__Secure-stnl_builder.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

/** A user row plus a live session for it, bypassing every sign-in flow. */
async function seedSession(user: { id: string; email: string; emailVerified: boolean; name: string }) {
  await state.pg!.query(`INSERT INTO hq_auth_user(id, name, email, "emailVerified") VALUES ($1, $2, $3, $4)`, [user.id, user.name, user.email, user.emailVerified]);
  const token = `token-${user.id}`;
  await state.pg!.query(`INSERT INTO hq_auth_session(id, "expiresAt", token, "userId") VALUES ($1, now() + interval '1 day', $2, $3)`, [`session-${user.id}`, token, user.id]);
  return signedSessionCookie(token);
}

describe("public HQ sign-in through Better Auth", () => {
  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", "postgres://test-only/member-auth");
    vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
    vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
    vi.stubEnv("RESEND_API_KEY", "test-only-sender");
    vi.stubEnv("EMAIL_FROM", "Superteam NL <test@example.com>");
    // Removed providers, stubbed deliberately: see the sign-in/social test below.
    vi.stubEnv("GOOGLE_CLIENT_ID", "test-google-client");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-google-secret");
    vi.stubEnv("GITHUB_CLIENT_ID", "test-github-client");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "test-github-secret");
    state.pg = new PGlite();
    await state.pg.exec(readFileSync("scripts/hq/schema.sql", "utf8"));
    await state.pg.exec(readFileSync("scripts/hq/builder-schema.sql", "utf8"));
    await state.pg.exec(readFileSync("scripts/hq/member-auth-schema.sql", "utf8"));
    route = await import("@/app/api/auth/[...all]/route");
  });

  beforeEach(async () => {
    state.sent.length = 0;
    state.synced.mockReset();
    state.emailFailure = false;
    state.cookie = "";
    ipNumber += 1;
    await state.pg!.exec("TRUNCATE hq_auth_user, hq_auth_verification, hq_auth_rate_limit, hq_builder_profiles, hq_hackathons CASCADE");
    await state.pg!.exec(`INSERT INTO hq_hackathons(id,slug,name,start_date,end_date) VALUES(41,'test-builders','Test builders','2098-09-01','2098-10-01')`);
  });

  afterAll(async () => {
    await state.pg?.close();
    vi.unstubAllEnvs();
  });

  it("creates a verified account and CRM profile only after a valid email code", async () => {
    const email = "new-builder@example.com";
    expect((await request("/email-otp/send-verification-otp", { email, type: "sign-in" })).status).toBe(200);
    expect(state.sent).toHaveLength(1);
    expect((await state.pg!.query("SELECT * FROM hq_auth_user")).rows).toHaveLength(0);
    expect(state.synced).not.toHaveBeenCalled();
    const code = latestCode();
    const stored = await state.pg!.query<{ value: string }>("SELECT value FROM hq_auth_verification");
    expect(stored.rows[0].value).not.toContain(code);

    const signedIn = await request("/sign-in/email-otp", { email, otp: code, name: "Test Builder" });
    expect(signedIn.status).toBe(200);
    const user = (await signedIn.json()).user;
    expect(user.emailVerified).toBe(true);
    expect(state.synced).toHaveBeenCalledWith({ id: user.id, email, name: "Test Builder" });
    expect((await state.pg!.query(`SELECT p.name,p.contact,r.label,p.hackathon_id FROM hq_people p JOIN hq_people_roles r ON r.id=p.role_id WHERE builder_user_id=$1`, [user.id])).rows).toEqual([
      { name: "Test Builder", contact: email, label: "Builder", hackathon_id: 41 },
    ]);
    const cookie = signedIn.headers.get("set-cookie")!;
    // The actual Set-Cookie line, with NODE_ENV not production: the attributes follow the https origin.
    expect(process.env.NODE_ENV).not.toBe("production");
    expect(signedIn.headers.getSetCookie()).toEqual([expect.stringMatching(SESSION_COOKIE_LINE)]);
    expect(cookie).not.toContain("hq_session=");
    const session = await request("/get-session", undefined, cookie.split(";")[0]);
    expect((await session.json()).user.id).toBe(user.id);
    expect((await request("/sign-in/email-otp", { email, otp: code })).status).toBe(400);
  });

  it("signs an existing user in without duplicating accounts or changing their name", async () => {
    const email = "returning@example.com";
    await request("/email-otp/send-verification-otp", { email, type: "sign-in" });
    await request("/sign-in/email-otp", { email, otp: latestCode(), name: "Original Name" });
    await request("/email-otp/send-verification-otp", { email, type: "sign-in" });
    const result = await request("/sign-in/email-otp", { email, otp: latestCode(), name: "Replacement" });
    expect(result.status).toBe(200);
    expect((await result.json()).user.name).toBe("Original Name");
    expect((await state.pg!.query("SELECT * FROM hq_auth_user")).rows).toHaveLength(1);
    expect(state.synced).toHaveBeenCalledTimes(1);
    expect((await state.pg!.query("SELECT * FROM hq_people")).rows).toHaveLength(1);
  });

  it("completes a new email-only sign-in profile before creating its Person", async () => {
    const email = "needs-name@example.com";
    await request("/email-otp/send-verification-otp", { email, type: "sign-in" });
    const response = await request("/sign-in/email-otp", { email, otp: latestCode() });
    expect(response.status).toBe(200);
    state.cookie = response.headers.get("set-cookie")!.split(";")[0];
    expect(state.synced).not.toHaveBeenCalled();
    expect((await state.pg!.query("SELECT * FROM hq_people")).rows).toHaveLength(0);
    const { currentMember, requireMember } = await import("@/lib/hq/member-auth");
    expect((await currentMember())?.name).toBe("");
    await expect(requireMember("/hq/join?code=abc")).rejects.toThrow("REDIRECT:/hq/profile?next=%2Fhq%2Fjoin%3Fcode%3Dabc");

    const { completeMemberProfile } = await import("@/app/hq/(member)/profile/actions");
    const empty = new FormData();
    empty.set("name", "   ");
    expect(await completeMemberProfile(null, empty)).toEqual({ error: "Enter your name, using 120 characters or fewer." });
    const form = new FormData();
    form.set("name", "Recovered Builder");
    form.set("next", "/hq/join?code=abc");
    await expect(completeMemberProfile(null, form)).rejects.toThrow("REDIRECT:/hq/join?code=abc");
    expect((await state.pg!.query("SELECT name FROM hq_people")).rows).toEqual([{ name: "Recovered Builder" }]);
    expect((await requireMember("/hq/join?code=abc")).name).toBe("Recovered Builder");
  });

  it("still treats a verified email account as a member", async () => {
    const email = "verified@example.com";
    await request("/email-otp/send-verification-otp", { email, type: "sign-in" });
    const signedIn = await request("/sign-in/email-otp", { email, otp: latestCode(), name: "Verified Builder" });
    state.cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
    const { currentMember, requireMember } = await import("@/lib/hq/member-auth");
    const user = (await signedIn.json()).user;
    expect(await currentMember()).toEqual({ id: user.id, email, name: "Verified Builder" });
    expect((await requireMember("/hq/dashboard")).email).toBe(email);
    expect(state.synced).toHaveBeenCalled();
  });

  it("admits a placeholder account only through its Telegram identity row, and syncs it without an email", async () => {
    const id = "telegram-only-user";
    state.cookie = await seedSession({ id, email: "1234123412341234123@telegram.placeholder.invalid", emailVerified: false, name: "Telegram Builder" });
    const { currentMember, requireMember } = await import("@/lib/hq/member-auth");
    expect((await (await request("/get-session", undefined, state.cookie)).json()).user.id).toBe(id);

    // Without the identity row a session is not a member: fail closed, and nothing is synced.
    expect(await currentMember()).toBeNull();
    // The gate ends the unusable session and tells the sign-in page why.
    await expect(requireMember("/hq/dashboard")).rejects.toThrow("REDIRECT:/hq/signin?error=identity_missing&next=%2Fhq%2Fdashboard");
    expect(state.synced).not.toHaveBeenCalled();
    expect(await (await request("/get-session", undefined, state.cookie)).json()).toBeNull();
    await state.pg!.query(`INSERT INTO hq_auth_session(id, "expiresAt", token, "userId") VALUES ('session-2', now() + interval '1 day', 'token-2', $1)`, [id]);
    state.cookie = await signedSessionCookie("token-2");

    await state.pg!.query(`INSERT INTO hq_auth_telegram_identity(user_id, provider_subject, telegram_user_id) VALUES ($1, '1234123412341234123', 7000000000123)`, [id]);
    expect(await currentMember()).toEqual({ id, email: null, name: "Telegram Builder" });
    expect((await requireMember("/hq/dashboard")).email).toBeNull();
    // The CRM sync is null-safe: a profile without an email, a People card without a contact, never the placeholder.
    expect(state.synced).toHaveBeenCalledWith({ id, email: null, name: "Telegram Builder" });
    expect((await state.pg!.query("SELECT id, email, contact_email, name FROM hq_builder_profiles")).rows).toEqual([{ id, email: null, contact_email: null, name: "Telegram Builder" }]);
    expect((await state.pg!.query("SELECT name, contact, person_id IS NOT NULL AS has_person, hackathon_id FROM hq_people")).rows)
      .toEqual([{ name: "Telegram Builder", contact: "", has_person: true, hackathon_id: 41 }]);

    const { getLoginMethods } = await import("@/lib/hq/identity");
    expect(await getLoginMethods(id)).toEqual({
      email: null,
      telegram: expect.objectContaining({ userId: id, telegramUserId: "7000000000123", providerSubject: "1234123412341234123" }),
      contactEmail: null,
    });
  });

  it("completes a Telegram-only profile through the one verified-account rule and never writes the placeholder", async () => {
    const id = "telegram-only-unnamed";
    state.cookie = await seedSession({ id, email: "5555555555555555555@telegram.placeholder.invalid", emailVerified: false, name: "" });
    await state.pg!.query(`INSERT INTO hq_auth_telegram_identity(user_id, provider_subject, telegram_user_id, username) VALUES ($1, '5555555555555555555', 5550000000055, 'tg_unnamed')`, [id]);
    const { currentMember, requireMember } = await import("@/lib/hq/member-auth");
    // Admitted by the identity row, not yet named: no People card until the profile step, as for an email account.
    expect(await currentMember()).toEqual({ id, email: null, name: "" });
    await expect(requireMember("/hq/dashboard")).rejects.toThrow("REDIRECT:/hq/profile?next=%2Fhq%2Fdashboard");
    expect(state.synced).not.toHaveBeenCalled();
    expect((await state.pg!.query("SELECT * FROM hq_people")).rows).toHaveLength(0);

    const { completeMemberProfile } = await import("@/app/hq/(member)/profile/actions");
    const form = new FormData();
    form.set("name", "Named Telegram Builder");
    form.set("next", "/hq/dashboard");
    await expect(completeMemberProfile(null, form)).rejects.toThrow("REDIRECT:/hq/dashboard");
    expect(state.synced).toHaveBeenCalledWith({ id, email: null, name: "Named Telegram Builder" });
    expect((await state.pg!.query("SELECT id, email, contact_email, name FROM hq_builder_profiles")).rows).toEqual([{ id, email: null, contact_email: null, name: "Named Telegram Builder" }]);
    expect((await state.pg!.query("SELECT name, contact, hackathon_id FROM hq_people")).rows).toEqual([{ name: "Named Telegram Builder", contact: "", hackathon_id: 41 }]);
    expect((await state.pg!.query("SELECT count(*)::int AS n FROM hq_people WHERE contact ILIKE '%placeholder.invalid%'")).rows).toEqual([{ n: 0 }]);
    expect((await requireMember("/hq/dashboard")).name).toBe("Named Telegram Builder");
  });

  it("defines the verified-account rule once, in lib/hq/identity.ts, and every session reader imports it", () => {
    const identity = readFileSync("lib/hq/identity.ts", "utf8");
    expect(identity).toMatch(/export async function isVerifiedAccount\(/);
    expect(identity).toMatch(/export function verifiedLoginEmail\(/);
    const memberAuth = readFileSync("lib/hq/member-auth.ts", "utf8");
    expect(memberAuth).toMatch(/isVerifiedAccount\(session\.user\)/);
    expect(memberAuth).toMatch(/isVerifiedAccount\(user\)/);
    // No second copy of the rule: neither the session module nor the profile action re-derives it.
    for (const file of ["lib/hq/member-auth.ts", "app/hq/(member)/profile/actions.ts"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/hasTelegramIdentity|emailVerified\s*&&/);
    }
  });

  it("returns no contact for an unverified real email admitted through a Telegram identity", async () => {
    // A still-registered OAuth provider can store a real address with emailVerified false.
    const id = "telegram-with-unverified-email";
    state.cookie = await seedSession({ id, email: "unverified-real@example.com", emailVerified: false, name: "Linked Builder" });
    await state.pg!.query(`INSERT INTO hq_auth_telegram_identity(user_id, provider_subject, telegram_user_id) VALUES ($1, '2222222222222222222', 4200000000042)`, [id]);
    const { currentMember, requireMember } = await import("@/lib/hq/member-auth");
    expect(await currentMember()).toEqual({ id, email: null, name: "Linked Builder" });
    expect((await requireMember("/hq/dashboard")).email).toBeNull();
    expect(state.synced).toHaveBeenCalledWith({ id, email: null, name: "Linked Builder" });
    expect((await state.pg!.query("SELECT contact FROM hq_people")).rows).toEqual([{ contact: "" }]);
    expect((await state.pg!.query("SELECT email FROM hq_builder_profiles")).rows).toEqual([{ email: null }]);
    // The unverified address is still reported as a login method, unverified; never as a contact.
    const { getLoginMethods } = await import("@/lib/hq/identity");
    expect(await getLoginMethods(id)).toMatchObject({ email: { address: "unverified-real@example.com", verified: false }, contactEmail: null });
  });

  it("reports login methods and the self-declared contact email separately", async () => {
    const email = "methods@example.com";
    await request("/email-otp/send-verification-otp", { email, type: "sign-in" });
    const signedIn = await request("/sign-in/email-otp", { email, otp: latestCode(), name: "Methods Builder" });
    const { id } = (await signedIn.json()).user;
    const { getLoginMethods } = await import("@/lib/hq/identity");
    expect(await getLoginMethods(id)).toEqual({ email: { address: email, verified: true }, telegram: null, contactEmail: null });
    await state.pg!.query("UPDATE hq_builder_profiles SET contact_email = 'reach-me@example.com' WHERE id = $1", [id]);
    expect((await getLoginMethods(id)).contactEmail).toBe("reach-me@example.com");
    expect(await getLoginMethods("unknown-user")).toEqual({ email: null, telegram: null, contactEmail: null });
  });

  it("rejects incorrect and expired codes without populating People", async () => {
    const email = "unverified@example.com";
    await request("/email-otp/send-verification-otp", { email, type: "sign-in" });
    const code = latestCode();
    const wrong = code === "000000" ? "111111" : "000000";
    expect((await request("/sign-in/email-otp", { email, otp: wrong })).status).toBe(400);
    await state.pg!.exec(`UPDATE hq_auth_verification SET "expiresAt" = now() - interval '1 minute'`);
    expect((await request("/sign-in/email-otp", { email, otp: code })).status).toBe(400);
    expect(state.synced).not.toHaveBeenCalled();
  });

  it("rate-limits code sends across requests using the database", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await request("/email-otp/send-verification-otp", { email: "rate@example.com", type: "sign-in" })).status).toBe(200);
    }
    expect((await request("/email-otp/send-verification-otp", { email: "rate@example.com", type: "sign-in" })).status).toBe(429);
    expect(state.sent).toHaveLength(3);
  });

  // The budget is decided per client address and path before any handler
  // runs, so a body the handler would refuse still spends it. The limits are
  // the library's default for /sign-in/social, the repo's custom rule for the
  // sign-in code, and the emailOTP plugin's for the change-email pair.
  it.each([
    ["/sign-in/social", { provider: "telegram", callbackURL: "/hq/welcome" }, 3],
    ["/sign-in/email-otp", { email: "budget@example.com", otp: "000000" }, 5],
    ["/email-otp/request-email-change", { newEmail: "budget@example.com" }, 3],
    ["/email-otp/change-email", { newEmail: "budget@example.com", otp: "000000" }, 3],
  ])("allows %s %i times per window from one address, then answers 429", async (path, body, max) => {
    for (let attempt = 1; attempt <= max; attempt += 1) expect((await request(path, body)).status, `${path} attempt ${attempt}`).not.toBe(429);
    const limited = await request(path, body);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("x-retry-after")).toMatch(/^\d+$/);
    // Another address is a separate budget.
    expect((await request(path, body, undefined, "198.51.100.77")).status).not.toBe(429);
    expect(state.sent).toEqual([]);
  });

  it("reads the client address from x-real-ip alone, and only when it is a single address", () => {
    const options = { advanced: { ipAddress: { ipAddressHeaders: ["x-real-ip"] } } };
    expect(getIP(new Headers({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" }), options)).toBe("203.0.113.9");
    // A forwarded chain in the trusted header is not unpicked without trustedProxies, and x-forwarded-for is never read;
    // outside test and development the library then keys every such request on one shared bucket.
    expect(getIP(new Headers({ "x-real-ip": "198.51.100.1, 203.0.113.9" }), options)).toBe("127.0.0.1");
    expect(getIP(new Headers({ "x-forwarded-for": "198.51.100.1" }), options)).toBe("127.0.0.1");
    expect(getIP(new Headers({ "x-real-ip": "not-an-address" }), options)).toBe("127.0.0.1");
  });

  it("answers a sign-in code request for a known address exactly like one for an unknown address, and serves no other code type", async () => {
    const known = "known@example.com";
    const unknown = "unknown@example.com";
    let ip = 0;
    const send = (email: string, type: string) => request("/email-otp/send-verification-otp", { email, type }, undefined, `198.51.100.${(ip += 1)}`);
    expect((await send(known, "sign-in")).status).toBe(200);
    expect((await request("/sign-in/email-otp", { email: known, otp: latestCode(), name: "Known Builder" })).status).toBe(200);
    state.sent.length = 0;

    const forKnown = await send(known, "sign-in");
    const forUnknown = await send(unknown, "sign-in");
    expect([forKnown.status, forUnknown.status]).toEqual([200, 200]);
    expect(await forKnown.json()).toEqual(await forUnknown.json());
    // Both get a code, so neither the answer nor the mail says which one has an account.
    expect(state.sent.map((message) => message.to)).toEqual([known, unknown]);

    // The other types would mail a known address and answer an unknown one at once: refused for both, before any lookup.
    for (const type of ["email-verification", "forget-password", "change-email"]) {
      for (const email of [known, unknown]) {
        const refused = await send(email, type);
        expect(refused.status, `${type} ${email}`).toBe(400);
        expect((await refused.json()).code, `${type} ${email}`).toBe("INVALID_OTP_TYPE");
      }
    }
    expect(state.sent).toHaveLength(2);
    expect((await state.pg!.query("SELECT identifier FROM hq_auth_verification WHERE identifier NOT LIKE 'sign-in-otp-%'")).rows).toEqual([]);
  });

  it("keeps the code endpoints HQ does not use disabled, ahead of the rate limiter", async () => {
    const email = "unused@example.com";
    const attempts: Array<[string, object]> = [
      ["/email-otp/check-verification-otp", { email, type: "sign-in", otp: "000000" }],
      ["/email-otp/verify-email", { email, otp: "000000" }],
      ["/email-otp/request-password-reset", { email }],
      ["/forget-password/email-otp", { email }],
      ["/email-otp/reset-password", { email, otp: "000000", password: "irrelevant-password" }],
    ];
    for (const [path, body] of attempts) expect((await request(path, body)).status, path).toBe(404);
    expect(state.sent).toEqual([]);
    expect((await state.pg!.query("SELECT * FROM hq_auth_verification")).rows).toEqual([]);
    expect((await state.pg!.query("SELECT * FROM hq_auth_rate_limit")).rows).toEqual([]);
  });

  it("spends the sign-in code's three attempts and then refuses even the right code", async () => {
    const email = "budget@example.com";
    await request("/email-otp/send-verification-otp", { email, type: "sign-in" });
    const code = latestCode();
    const wrong = code === "000000" ? "111111" : "000000";
    let ip = 0;
    const guess = (otp: string) => request("/sign-in/email-otp", { email, otp }, undefined, `198.51.100.${(ip += 1)}`);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const refused = await guess(wrong);
      expect(refused.status, `attempt ${attempt}`).toBe(400);
      expect((await refused.json()).code, `attempt ${attempt}`).toBe("INVALID_OTP");
    }
    // The sign-in route keeps the library's own answer: a code is not an account, so there is nothing to hide here.
    const spent = await guess(code);
    expect(spent.status).toBe(403);
    expect((await spent.json()).code).toBe("TOO_MANY_ATTEMPTS");
    expect((await guess(code)).status).toBe(400);
    expect((await state.pg!.query("SELECT * FROM hq_auth_user")).rows).toHaveLength(0);
  });

  it("does not pretend email delivery succeeded when the sender fails", async () => {
    state.emailFailure = true;
    const response = await request("/email-otp/send-verification-otp", { email: "sender@example.com", type: "sign-in" });
    expect(response.status).toBe(503);
    expect(state.synced).not.toHaveBeenCalled();
  });

  // The GOOGLE_*/GITHUB_* variables stubbed in beforeAll are set on purpose:
  // credentials left behind in an environment must not resurrect a provider.
  it.each(["google", "github"])("no longer offers %s sign-in, whatever the environment holds", async (provider) => {
    const response = await request("/sign-in/social", { provider, callbackURL: "/hq/welcome" });
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("PROVIDER_NOT_FOUND");
  });

  it("rejects cross-origin mutation and does not accept the operator cookie as a public session", async () => {
    const response = await route.POST(new Request(`${ORIGIN}/api/auth/email-otp/send-verification-otp`, {
      method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ email: "cross-origin@example.com", type: "sign-in" }),
    }));
    expect(response.status).toBe(403);
    expect(await (await request("/get-session", undefined, "hq_session=operator-cookie")).json()).toBeNull();
  });
});
