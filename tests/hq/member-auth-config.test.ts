import { describe, expect, it } from "vitest";
import { getMemberAuthAvailability, memberAuthOrigin, safeMemberNext } from "@/lib/hq/member-auth-config";

describe("public HQ authentication configuration", () => {
  const env = { DATABASE_URL: "postgres://local/test", BETTER_AUTH_SECRET: "test-secret-that-is-at-least-thirty-two-characters", BETTER_AUTH_URL: "https://nl.superteam.fun", NODE_ENV: "production" };

  it("does not advertise email sign-in without both an API key and a sender", () => {
    expect(getMemberAuthAvailability(env)).toEqual({ configured: true, email: false, telegram: false });
    expect(getMemberAuthAvailability({ ...env, RESEND_API_KEY: "key" }).email).toBe(false);
    expect(getMemberAuthAvailability({ ...env, RESEND_API_KEY: "key", EMAIL_FROM: "HQ <hq@example.com>" }).email).toBe(true);
  });

  it("reports exactly the configured, email and telegram flags", () => {
    const complete = { ...env, RESEND_API_KEY: "key", EMAIL_FROM: "HQ <hq@example.com>", TELEGRAM_LOGIN_CLIENT_ID: "123456789", TELEGRAM_LOGIN_CLIENT_SECRET: "secret" };
    expect(Object.keys(getMemberAuthAvailability(complete)).sort()).toEqual(["configured", "email", "telegram"]);
    expect(getMemberAuthAvailability(complete)).toEqual({ configured: true, email: true, telegram: true });
  });

  it("gives the removed Google and GitHub credentials no effect", () => {
    const legacy = { ...env, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" };
    expect(getMemberAuthAvailability(legacy)).toEqual(getMemberAuthAvailability(env));
  });

  it("advertises Telegram only with both login credentials, whatever the bot username", () => {
    expect(getMemberAuthAvailability({ ...env, TELEGRAM_LOGIN_CLIENT_ID: "123456789" }).telegram).toBe(false);
    expect(getMemberAuthAvailability({ ...env, TELEGRAM_LOGIN_CLIENT_SECRET: "secret", TELEGRAM_BOT_USERNAME: "fictional_bot" }).telegram).toBe(false);
    expect(getMemberAuthAvailability({ ...env, TELEGRAM_LOGIN_CLIENT_ID: "123456789", TELEGRAM_LOGIN_CLIENT_SECRET: "secret" }).telegram).toBe(true);
    expect(getMemberAuthAvailability({ ...env, DATABASE_URL: undefined, TELEGRAM_LOGIN_CLIENT_ID: "123456789", TELEGRAM_LOGIN_CLIENT_SECRET: "secret" }).telegram).toBe(false);
  });

  it("requires independent secrets and an explicit secure production origin", () => {
    expect(getMemberAuthAvailability({ ...env, BETTER_AUTH_SECRET: undefined, HQ_SESSION_SECRET: env.BETTER_AUTH_SECRET }).configured).toBe(false);
    expect(memberAuthOrigin({ ...env, BETTER_AUTH_URL: "http://nl.superteam.fun" })).toBeNull();
    expect(memberAuthOrigin({ ...env, BETTER_AUTH_URL: "http://localhost:3000" })).toBeNull();
    expect(memberAuthOrigin({ ...env, NODE_ENV: "development", BETTER_AUTH_URL: "http://localhost:3000" })).toBe("http://localhost:3000");
    expect(memberAuthOrigin({ ...env, BETTER_AUTH_URL: "https://username:secret@nl.superteam.fun" })).toBeNull();
  });
});

describe("public HQ post-auth destinations", () => {
  it.each([undefined, "https://evil.example", "//evil.example", "/\\evil.example", "/hq", "/hq/admin", "/hq/people", "/hq/dashboard/../../hq/admin", "/hq/%61dmin", "/hq/dashboard\n", "/hq/account/other", "/hq/accounts"]) ("rejects unsafe or operator destinations: %s", (value) => {
    expect(safeMemberNext(value)).toBe("/hq/welcome");
  });

  it.each(["/hq/dashboard", "/hq/welcome?hackathon=6", "/hq/join?code=abc123", "/hq/initialize", "/hq/team/1234-abcd", "/hq/account", "/hq/account?connected=telegram", "/hq/account/connect-telegram", "/hq/account/disconnect-telegram"]) ("preserves public destinations: %s", (value) => {
    expect(safeMemberNext(value)).toBe(value);
  });
});
