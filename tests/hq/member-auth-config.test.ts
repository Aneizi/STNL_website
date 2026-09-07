import { describe, expect, it } from "vitest";
import { getMemberAuthAvailability, memberAuthOrigin, safeMemberNext } from "@/lib/hq/member-auth-config";

describe("public HQ authentication configuration", () => {
  const env = { DATABASE_URL: "postgres://local/test", BETTER_AUTH_SECRET: "test-secret-that-is-at-least-thirty-two-characters", BETTER_AUTH_URL: "https://nl.superteam.fun", NODE_ENV: "production" };

  it("does not advertise providers without both credentials or a sender", () => {
    expect(getMemberAuthAvailability(env)).toEqual({ configured: true, email: false, google: false, github: false });
    expect(getMemberAuthAvailability({ ...env, GOOGLE_CLIENT_ID: "id" }).google).toBe(false);
    expect(getMemberAuthAvailability({ ...env, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" }).google).toBe(true);
    expect(getMemberAuthAvailability({ ...env, RESEND_API_KEY: "key", EMAIL_FROM: "HQ <hq@example.com>" }).email).toBe(true);
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
  it.each([undefined, "https://evil.example", "//evil.example", "/\\evil.example", "/hq", "/hq/admin", "/hq/people", "/hq/dashboard/../../hq/admin", "/hq/%61dmin", "/hq/dashboard\n"]) ("rejects unsafe or operator destinations: %s", (value) => {
    expect(safeMemberNext(value)).toBe("/hq/welcome");
  });

  it.each(["/hq/dashboard", "/hq/welcome?hackathon=6", "/hq/join?code=abc123", "/hq/initialize", "/hq/team/1234-abcd"]) ("preserves public destinations: %s", (value) => {
    expect(safeMemberNext(value)).toBe(value);
  });
});
