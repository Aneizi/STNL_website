import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
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
  return { ...store, syncBuilderAccount: async (user: { id: string; email: string; name: string }) => {
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

describe("public HQ sign-in through Better Auth", () => {
  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", "postgres://test-only/member-auth");
    vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
    vi.stubEnv("BETTER_AUTH_SECRET", "test-only-independent-auth-secret-0123456789");
    vi.stubEnv("RESEND_API_KEY", "test-only-sender");
    vi.stubEnv("EMAIL_FROM", "Superteam NL <test@example.com>");
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
    expect(cookie).toContain("stnl_builder.session_token=");
    expect(cookie).toContain("HttpOnly");
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

  it("does not pretend email delivery succeeded when the sender fails", async () => {
    state.emailFailure = true;
    const response = await request("/email-otp/send-verification-otp", { email: "sender@example.com", type: "sign-in" });
    expect(response.status).toBe(503);
    expect(state.synced).not.toHaveBeenCalled();
  });

  it.each(["google", "github"])("starts %s sign-in with the configured callback and CSRF state", async (provider) => {
    const response = await request("/sign-in/social", { provider, callbackURL: "/hq/welcome" });
    expect(response.status).toBe(200);
    const url = new URL((await response.json()).url);
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/${provider}`);
    expect(url.searchParams.get("state")).toBeTruthy();
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
