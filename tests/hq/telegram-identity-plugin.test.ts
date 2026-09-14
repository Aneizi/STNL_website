// The identity plugin's pure rules and its guard lists, without a database.
// The endpoint-level behaviour (what each guard does to a request) is proven
// in member-auth-telegram.test.ts against the real handler; this file pins
// the lists themselves and the two rules other modules import, so a path
// dropped from a set or a boundary moved by one millisecond fails here.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  hqTelegramIdentity,
  ID_TOKEN_ENDPOINTS,
  isRecentSession,
  PLACEHOLDER_GUARDED_ENDPOINTS,
  RECENT_SESSION_ENDPOINTS,
  RECENT_SESSION_MS,
  telegramIsLastLoginMethod,
} from "@/lib/hq/telegram-identity-plugin";

const sorted = (set: ReadonlySet<string>) => [...set].sort();

describe("Telegram identity plugin guard lists", () => {
  it("guards every endpoint that would mail, look up or verify an address from the body", () => {
    expect(sorted(PLACEHOLDER_GUARDED_ENDPOINTS)).toEqual([
      "/change-email",
      "/email-otp/change-email",
      "/email-otp/check-verification-otp",
      "/email-otp/request-email-change",
      "/email-otp/request-password-reset",
      "/email-otp/reset-password",
      "/email-otp/send-verification-otp",
      "/email-otp/verify-email",
      "/forget-password/email-otp",
      "/request-password-reset",
      "/send-verification-email",
      "/sign-in/email-otp",
      "/verify-email",
    ]);
  });

  it("closes both client id_token branches and puts every login-method endpoint, the disabled core one included, behind the recency window", () => {
    expect(sorted(ID_TOKEN_ENDPOINTS)).toEqual(["/link-social", "/sign-in/social"]);
    expect(sorted(RECENT_SESSION_ENDPOINTS)).toEqual(["/change-email", "/email-otp/change-email", "/email-otp/request-email-change", "/link-social", "/unlink-account"]);
    expect(RECENT_SESSION_MS).toBe(15 * 60 * 1000);
  });

  it("matches each hook on exactly its own route templates", () => {
    const hooks = hqTelegramIdentity().hooks?.before ?? [];
    expect(hooks).toHaveLength(3);
    const matching = (path: string) => hooks.map((hook, index) => (hook.matcher({ path } as Parameters<typeof hook.matcher>[0]) ? index : -1)).filter((index) => index >= 0);
    for (const path of PLACEHOLDER_GUARDED_ENDPOINTS) expect(matching(path), path).toContain(0);
    for (const path of ID_TOKEN_ENDPOINTS) expect(matching(path), path).toContain(1);
    for (const path of RECENT_SESSION_ENDPOINTS) expect(matching(path), path).toContain(2);
    // Route templates, never request paths: the callback is /callback/:id.
    for (const path of ["/callback/:id", "/callback/telegram", "/get-session", "/sign-out", "/update-user", "/list-accounts", ""]) expect(matching(path), path).toEqual([]);
    expect(matching("/link-social")).toEqual([1, 2]);
    expect(matching("/email-otp/change-email")).toEqual([0, 2]);
    expect(matching("/change-email")).toEqual([0, 2]);
  });
});

describe("the recency rule", () => {
  const now = Date.UTC(2026, 8, 14, 12, 0, 0);

  it("accepts a session created less than the window ago and refuses one at the boundary or older", () => {
    expect(isRecentSession({ createdAt: new Date(now - RECENT_SESSION_MS + 1) }, now)).toBe(true);
    expect(isRecentSession({ createdAt: new Date(now) }, now)).toBe(true);
    expect(isRecentSession({ createdAt: new Date(now - RECENT_SESSION_MS) }, now)).toBe(false);
    expect(isRecentSession({ createdAt: new Date(now - RECENT_SESSION_MS - 1) }, now)).toBe(false);
    expect(isRecentSession({ createdAt: new Date(now - 24 * 60 * 60 * 1000) }, now)).toBe(false);
  });

  it("reads the creation time however the adapter hands it back", () => {
    expect(isRecentSession({ createdAt: new Date(now - 60_000).toISOString() }, now)).toBe(true);
    expect(isRecentSession({ createdAt: new Date(now - 60 * 60_000).toISOString() }, now)).toBe(false);
    expect(isRecentSession({ createdAt: "not a date" }, now)).toBe(false);
  });
});

describe("the last-login-method rule", () => {
  it("counts only a verified real email as a way back in", () => {
    expect(telegramIsLastLoginMethod({ email: "1234@telegram.placeholder.invalid", emailVerified: false })).toBe(true);
    // A placeholder is never a login email, whatever the flag says.
    expect(telegramIsLastLoginMethod({ email: "1234@telegram.placeholder.invalid", emailVerified: true })).toBe(true);
    expect(telegramIsLastLoginMethod({ email: "builder@example.com", emailVerified: false })).toBe(true);
    expect(telegramIsLastLoginMethod({ email: "builder@example.com", emailVerified: true })).toBe(false);
  });
});
