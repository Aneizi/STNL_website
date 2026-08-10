import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

// session-token.ts is server-only; the guard package throws outside a
// React Server environment, so stub it for the test runner.
vi.mock("server-only", () => ({}));

import { signSessionToken, verifySessionToken } from "@/lib/hq/session-token";

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
process.env.HQ_SESSION_SECRET = SECRET;

const payload = {
  userId: "6f3f19c5-59f5-4d02-9c33-3aa54a0c11ab",
  pwv: 3,
  sid: "b34cf5d1-c56f-4d4e-8ffe-4bd6f6a3f0d2",
};

function encode(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

describe("hq session tokens", () => {
  it("round-trips a valid token", async () => {
    const token = await signSessionToken(payload, new Date(Date.now() + 60_000));
    expect(await verifySessionToken(token)).toEqual(payload);
  });

  it("rejects an expired token", async () => {
    const token = await signSessionToken(payload, new Date(Date.now() - 60_000));
    expect(await verifySessionToken(token)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const forged = await new SignJWT({ pwv: payload.pwv, sid: payload.sid })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(payload.userId)
      .setIssuedAt()
      .setExpirationTime(new Date(Date.now() + 60_000))
      .sign(encode("attacker-controlled-secret-0123456789abcdef"));
    expect(await verifySessionToken(forged)).toBeNull();
  });

  it("rejects a token signed with a different algorithm", async () => {
    const hs384 = await new SignJWT({ pwv: payload.pwv, sid: payload.sid })
      .setProtectedHeader({ alg: "HS384" })
      .setSubject(payload.userId)
      .setIssuedAt()
      .setExpirationTime(new Date(Date.now() + 60_000))
      .sign(encode(SECRET));
    expect(await verifySessionToken(hs384)).toBeNull();
  });

  it("rejects legacy tokens without a session id", async () => {
    const legacy = await new SignJWT({ pwv: payload.pwv })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(payload.userId)
      .setIssuedAt()
      .setExpirationTime(new Date(Date.now() + 60_000))
      .sign(encode(SECRET));
    expect(await verifySessionToken(legacy)).toBeNull();
  });

  it("rejects tokens missing a subject", async () => {
    const anonymous = await new SignJWT({ pwv: payload.pwv, sid: payload.sid })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(new Date(Date.now() + 60_000))
      .sign(encode(SECRET));
    expect(await verifySessionToken(anonymous)).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(await verifySessionToken("not-a-jwt")).toBeNull();
    expect(await verifySessionToken("")).toBeNull();
  });
});
