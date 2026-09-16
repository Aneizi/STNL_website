// Regression anchor for the operator (admin) username/password sign-in.
//
// Phase 0 of the Captains plan requires that the existing operator boundary
// keeps working while the public member side is rebuilt. Until now `login`,
// `changePassword` and `logout` were only covered by SQL *copied* into
// tests/hq/database.test.ts, so a change inside lib/hq/actions/auth.ts could
// not fail a test. This file calls the real exported Server Actions.
//
// Only the edges are stubbed: `pg` is pointed at an in-process PostgreSQL
// (PGlite) so lib/hq/db.ts's own local adapter, its tagged-template parameter
// binding and every constraint are genuinely exercised, and `next/headers` /
// `next/navigation` stand in for the request context. Nothing in lib/hq is
// mocked. Every credential below is fictional.
import { PGlite } from "@electric-sql/pglite";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "./helpers/db";

const state = vi.hoisted(() => ({
  pg: null as PGlite | null,
  /** The cookie store `next/headers` would hand the action. */
  jar: new Map<string, { value: string; options: Record<string, unknown> }>(),
  ip: "198.51.100.1",
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": state.ip }),
  cookies: async () => ({
    get: (name: string) => {
      const found = state.jar.get(name);
      return found ? { name, value: found.value } : undefined;
    },
    set: (name: string, value: string, options: Record<string, unknown>) => {
      state.jar.set(name, { value, options });
    },
    delete: (name: string) => {
      state.jar.delete(name);
    },
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("pg", () => ({
  // Real PostgreSQL statements and constraints, with an in-process transport.
  Pool: class {
    async query(text: string, values: unknown[] = []) {
      return state.pg!.query(text, values);
    }
    async connect() {
      return {
        query: async (text: string, values: unknown[] = []) => state.pg!.query(text, values),
        release() {},
        on() {},
        removeListener() {},
      };
    }
    on() {
      return this;
    }
    async end() {}
  },
}));

const COOKIE = "hq_session";
const GENERIC_ERROR = "Invalid username or password.";
const THROTTLE_ERROR = "Too many attempts. Try again in a few minutes.";
const USERNAME = "fictional.operator";
const DISPLAY_NAME = "Fictional Operator";
const PASSWORD = "fictional-operator-passphrase";
const NEXT_PASSWORD = "second-fictional-passphrase";
const DAY_MS = 24 * 60 * 60 * 1000;

let actions: typeof import("@/lib/hq/actions/auth");
let auth: typeof import("@/lib/hq/auth");
let tokens: typeof import("@/lib/hq/session-token");
/** Hashed once at the code's own cost; bcryptjs at cost 12 is deliberately slow. */
let passwordHash: string;
let addressCounter = 0;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function rows<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await state.pg!.query(text, params)).rows as T[];
}

async function seedOperator(
  opts: { username?: string; mustChange?: boolean } = {},
): Promise<string> {
  const [row] = await rows<{ id: string }>(
    `INSERT INTO hq_users (username, display_name, password_hash, must_change_password)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [opts.username ?? USERNAME, DISPLAY_NAME, passwordHash, opts.mustChange ?? false],
  );
  return row.id;
}

/** The cookie the action just issued, or undefined if it issued none. */
function issuedCookie() {
  return state.jar.get(COOKIE);
}

beforeAll(async () => {
  // A localhost URL keeps lib/hq/db.ts on its node-postgres adapter, which the
  // mock above redirects into PGlite. No real database is reachable from here.
  vi.stubEnv("DATABASE_URL", "postgres://operator-tests@localhost:5432/operator-tests");
  vi.stubEnv("HQ_SESSION_SECRET", "test-only-operator-session-secret-0123456789");
  state.pg = new PGlite();
  await applyMigrations(state.pg);
  passwordHash = await bcrypt.hash(PASSWORD, 12);
  actions = await import("@/lib/hq/actions/auth");
  auth = await import("@/lib/hq/auth");
  tokens = await import("@/lib/hq/session-token");
}, 120_000);

beforeEach(async () => {
  await state.pg!.exec(
    `TRUNCATE hq_users, hq_sessions, hq_login_attempts, hq_login_limits,
              hq_auth_user, hq_auth_session CASCADE`,
  );
  state.jar.clear();
  // A fresh address per test: the limiter keys on it and windows are wall-clock.
  addressCounter += 1;
  state.ip = `198.51.100.${addressCounter}`;
});

afterAll(async () => {
  await state.pg?.close();
  vi.unstubAllEnvs();
});

describe("operator login", () => {
  it("signs a known operator in, issues the session cookie and lands on the picker", async () => {
    const id = await seedOperator();

    await expect(
      actions.login(null, form({ username: USERNAME, password: PASSWORD })),
    ).rejects.toThrow("REDIRECT:/hq/select");

    const cookie = issuedCookie()!;
    expect(cookie).toBeDefined();
    // secure is process.env.NODE_ENV === "production"; the suite runs as "test".
    expect(cookie.options).toMatchObject({
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
    });
    const ttl = (cookie.options.expires as Date).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(6.9 * DAY_MS);
    expect(ttl).toBeLessThanOrEqual(7 * DAY_MS);

    const sessions = await rows<{ id: string; user_id: string }>(
      "SELECT id, user_id FROM hq_sessions",
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0].user_id).toBe(id);
    expect(await tokens.verifySessionToken(cookie.value)).toEqual({
      userId: id,
      pwv: 1,
      sid: sessions[0].id,
    });

    expect(await rows("SELECT username, ip, success FROM hq_login_attempts")).toEqual([
      { username: USERNAME, ip: state.ip, success: true },
    ]);

    expect(await auth.currentUser()).toEqual({
      id,
      username: USERNAME,
      displayName: DISPLAY_NAME,
      mustChangePassword: false,
    });
  });

  it("normalises the submitted username before the lookup", async () => {
    const id = await seedOperator();

    await expect(
      actions.login(null, form({ username: `  ${USERNAME.toUpperCase()}  `, password: PASSWORD })),
    ).rejects.toThrow("REDIRECT:/hq/select");

    expect((await rows<{ user_id: string }>("SELECT user_id FROM hq_sessions"))[0].user_id).toBe(id);
    expect(
      (await rows<{ username: string }>("SELECT username FROM hq_login_attempts"))[0].username,
    ).toBe(USERNAME);
  });

  it("sends an operator who must change their password to the change-password screen", async () => {
    await seedOperator({ mustChange: true });

    await expect(
      actions.login(null, form({ username: USERNAME, password: PASSWORD })),
    ).rejects.toThrow("REDIRECT:/hq/change-password");

    expect(issuedCookie()).toBeDefined();
    expect(await rows("SELECT id FROM hq_sessions")).toHaveLength(1);
    // The session is real, but every gated surface still bounces to the screen.
    await expect(auth.requireUser()).rejects.toThrow("REDIRECT:/hq/change-password");
    expect((await auth.requireUser({ allowMustChange: true })).mustChangePassword).toBe(true);
  });

  it("refuses a wrong password with a generic error, no cookie and a failed attempt row", async () => {
    await seedOperator();

    expect(
      await actions.login(null, form({ username: USERNAME, password: "not-the-passphrase" })),
    ).toEqual({ ok: false, error: GENERIC_ERROR, username: USERNAME });

    expect(state.jar.size).toBe(0);
    expect(await rows("SELECT id FROM hq_sessions")).toHaveLength(0);
    expect(await rows("SELECT username, success FROM hq_login_attempts")).toEqual([
      { username: USERNAME, success: false },
    ]);
  });

  it("gives an unknown username the same error and the same audit row", async () => {
    await seedOperator();

    expect(
      await actions.login(null, form({ username: "No-Such-Operator", password: PASSWORD })),
    ).toEqual({ ok: false, error: GENERIC_ERROR, username: "No-Such-Operator" });

    expect(state.jar.size).toBe(0);
    expect(await rows("SELECT username, success FROM hq_login_attempts")).toEqual([
      { username: "no-such-operator", success: false },
    ]);
  });

  it("rejects malformed input before the limiter or the audit log is touched", async () => {
    await seedOperator();

    expect(await actions.login(null, form({ username: "", password: PASSWORD }))).toEqual({
      ok: false,
      error: GENERIC_ERROR,
      username: "",
    });
    expect(
      await actions.login(null, form({ username: USERNAME, password: "x".repeat(257) })),
    ).toEqual({ ok: false, error: GENERIC_ERROR, username: USERNAME });

    expect(await rows("SELECT key FROM hq_login_limits")).toEqual([]);
    expect(await rows("SELECT id FROM hq_login_attempts")).toEqual([]);
    expect(state.jar.size).toBe(0);
  });

  it("locks a username and address pair out after five failures, then reopens", async () => {
    await seedOperator();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await actions.login(
        null,
        form({ username: USERNAME, password: `wrong-${attempt}` }),
      );
      expect(result.error).toBe(GENERIC_ERROR);
    }

    // The correct password is refused too: the limiter runs before bcrypt.
    expect(await actions.login(null, form({ username: USERNAME, password: PASSWORD }))).toEqual({
      ok: false,
      error: THROTTLE_ERROR,
      username: USERNAME,
    });
    expect(state.jar.size).toBe(0);
    expect(await rows("SELECT id FROM hq_sessions")).toHaveLength(0);
    // A blocked request costs one counter update and nothing else: still 5 rows.
    expect(await rows("SELECT id FROM hq_login_attempts")).toHaveLength(5);
    expect(
      await rows<{ key: string; count: number }>(
        "SELECT key, count FROM hq_login_limits ORDER BY key",
      ),
    ).toEqual([
      { key: `ip:${state.ip}`, count: 6 },
      { key: `user:${USERNAME}@${state.ip}`, count: 6 },
    ]);

    // Windows are fixed and 15 minutes long; move this one into the past.
    await state.pg!.query("UPDATE hq_login_limits SET window_start = now() - interval '20 minutes'");
    await expect(
      actions.login(null, form({ username: USERNAME, password: PASSWORD })),
    ).rejects.toThrow("REDIRECT:/hq/select");

    // A success gives its credit back, so the window counts failures only.
    expect(
      await rows<{ key: string; count: number }>(
        "SELECT key, count FROM hq_login_limits ORDER BY key",
      ),
    ).toEqual([{ key: `ip:${state.ip}`, count: 0 }]);
  }, 120_000);

  it("blocks a whole address once the per-address cap is reached", async () => {
    await seedOperator();
    // Twenty attempts already spent from this address inside the live window.
    await state.pg!.query(
      "INSERT INTO hq_login_limits (key, count, window_start) VALUES ($1, 20, now())",
      [`ip:${state.ip}`],
    );

    expect(await actions.login(null, form({ username: USERNAME, password: PASSWORD }))).toEqual({
      ok: false,
      error: THROTTLE_ERROR,
      username: USERNAME,
    });

    expect(state.jar.size).toBe(0);
    expect(await rows("SELECT id FROM hq_sessions")).toHaveLength(0);
    expect(await rows("SELECT id FROM hq_login_attempts")).toEqual([]);
    // The per-user counter was never reached, so the operator's own budget stands.
    expect(await rows("SELECT key FROM hq_login_limits")).toEqual([{ key: `ip:${state.ip}` }]);
  });
});

describe("operator changePassword", () => {
  it("requires a signed-in operator", async () => {
    await seedOperator();

    await expect(
      actions.changePassword(null, form({ password: NEXT_PASSWORD, confirm: NEXT_PASSWORD })),
    ).rejects.toThrow("REDIRECT:/hq/admin/login");

    expect(
      (await rows<{ password_version: number }>("SELECT password_version FROM hq_users"))[0]
        .password_version,
    ).toBe(1);
  });

  it("refuses a short password and a mismatch without changing anything", async () => {
    await seedOperator();
    await expect(
      actions.login(null, form({ username: USERNAME, password: PASSWORD })),
    ).rejects.toThrow("REDIRECT:/hq/select");
    const issued = issuedCookie()!.value;

    expect(await actions.changePassword(null, form({ password: "short", confirm: "short" }))).toEqual(
      { ok: false, error: "Password must be at least 12 characters." },
    );
    expect(
      await actions.changePassword(
        null,
        form({ password: NEXT_PASSWORD, confirm: "a-different-passphrase" }),
      ),
    ).toEqual({ ok: false, error: "Passwords do not match." });

    const [user] = await rows<{ password_version: number; password_hash: string }>(
      "SELECT password_version, password_hash FROM hq_users",
    );
    expect(user.password_version).toBe(1);
    expect(user.password_hash).toBe(passwordHash);
    expect(await rows("SELECT id FROM hq_sessions")).toHaveLength(1);
    expect(issuedCookie()!.value).toBe(issued);
  }, 60_000);

  it("bumps password_version, revokes every live session and re-issues one", async () => {
    const id = await seedOperator({ mustChange: true });
    await expect(
      actions.login(null, form({ username: USERNAME, password: PASSWORD })),
    ).rejects.toThrow("REDIRECT:/hq/change-password");
    const oldToken = issuedCookie()!.value;
    const oldSession = (await tokens.verifySessionToken(oldToken))!;
    // A second device, to prove the revocation is not limited to this one.
    await state.pg!.query(
      "INSERT INTO hq_sessions (user_id, expires_at) VALUES ($1, now() + interval '7 days')",
      [id],
    );

    await expect(
      actions.changePassword(null, form({ password: NEXT_PASSWORD, confirm: NEXT_PASSWORD })),
    ).rejects.toThrow("REDIRECT:/hq");

    const [user] = await rows<{
      password_version: number;
      must_change_password: boolean;
      password_hash: string;
    }>("SELECT password_version, must_change_password, password_hash FROM hq_users WHERE id = $1", [
      id,
    ]);
    expect(user.password_version).toBe(2);
    expect(user.must_change_password).toBe(false);
    expect(await bcrypt.compare(NEXT_PASSWORD, user.password_hash)).toBe(true);

    const sessions = await rows<{ id: string }>("SELECT id FROM hq_sessions");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).not.toBe(oldSession.sid);

    const newToken = issuedCookie()!.value;
    expect(newToken).not.toBe(oldToken);
    expect(await tokens.verifySessionToken(newToken)).toEqual({
      userId: id,
      pwv: 2,
      sid: sessions[0].id,
    });
    expect(await auth.currentUser()).toEqual({
      id,
      username: USERNAME,
      displayName: DISPLAY_NAME,
      mustChangePassword: false,
    });

    // The old token is still a valid, unexpired signature...
    expect(await tokens.verifySessionToken(oldToken)).toEqual({
      userId: id,
      pwv: 1,
      sid: oldSession.sid,
    });
    // ...and still opens nothing, because its row is gone.
    state.jar.set(COOKIE, { value: oldToken, options: {} });
    expect(await auth.currentUser()).toBeNull();
    await expect(auth.requireUser()).rejects.toThrow("REDIRECT:/hq/admin/login");

    // Even were the row restored, the password_version bump alone rejects it.
    await state.pg!.query(
      "INSERT INTO hq_sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '7 days')",
      [oldSession.sid, id],
    );
    expect(await auth.currentUser()).toBeNull();
  }, 120_000);
});

describe("operator logout", () => {
  it("deletes the session row, clears the cookie and returns to the login screen", async () => {
    await seedOperator();
    await expect(
      actions.login(null, form({ username: USERNAME, password: PASSWORD })),
    ).rejects.toThrow("REDIRECT:/hq/select");
    expect(await auth.currentUser()).not.toBeNull();

    await expect(actions.logout()).rejects.toThrow("REDIRECT:/hq/admin/login");

    expect(state.jar.has(COOKIE)).toBe(false);
    expect(await rows("SELECT id FROM hq_sessions")).toHaveLength(0);
    expect(await auth.currentUser()).toBeNull();
  });

  it("clears an unreadable cookie without touching anyone else's session", async () => {
    const id = await seedOperator();
    await state.pg!.query(
      "INSERT INTO hq_sessions (user_id, expires_at) VALUES ($1, now() + interval '7 days')",
      [id],
    );
    state.jar.set(COOKIE, { value: "not-a-signed-token", options: {} });

    await expect(actions.logout()).rejects.toThrow("REDIRECT:/hq/admin/login");

    expect(state.jar.has(COOKIE)).toBe(false);
    expect(await rows("SELECT id FROM hq_sessions")).toHaveLength(1);
  });
});

describe("the operator session and the public member session stay separate", () => {
  // tests/hq/member-auth.test.ts asserts the other direction: an hq_session
  // cookie is not a public session. This is the inverse.
  it("does not accept a live public member cookie as an operator session", async () => {
    await seedOperator();
    await state.pg!.query(
      `INSERT INTO hq_auth_user (id, name, email, "emailVerified")
       VALUES ('fictional-member', 'Fictional Builder', 'fictional-builder@example.com', true)`,
    );
    await state.pg!.query(
      `INSERT INTO hq_auth_session (id, "expiresAt", token, "userId")
       VALUES ('fictional-member-session', now() + interval '1 day', $1, 'fictional-member')`,
      ["fictional-member-session-token"],
    );

    state.jar.set("stnl_builder.session_token", {
      value: "fictional-member-session-token",
      options: {},
    });
    state.jar.set("__Secure-stnl_builder.session_token", {
      value: "fictional-member-session-token",
      options: {},
    });
    expect(await auth.currentUser()).toBeNull();
    await expect(auth.requireUser()).rejects.toThrow("REDIRECT:/hq/admin/login");

    // Copied into the operator cookie name it is still not a signed hq_session.
    state.jar.set(COOKIE, { value: "fictional-member-session-token", options: {} });
    expect(await tokens.verifySessionToken("fictional-member-session-token")).toBeNull();
    expect(await auth.currentUser()).toBeNull();
  });
});
