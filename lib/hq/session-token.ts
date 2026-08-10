import "server-only";
import { SignJWT, jwtVerify } from "jose";

// Pure sign/verify for the hq_session JWT — no framework or database
// imports, so the token boundary is unit-testable in isolation.

function secret(): Uint8Array {
  const value = process.env.HQ_SESSION_SECRET;
  if (!value) throw new Error("HQ_SESSION_SECRET is not set");
  return new TextEncoder().encode(value);
}

// sid points at a hq_sessions row — deleting the row (logout, password
// change) revokes the token immediately. pwv (password_version) also
// invalidates every token issued before a password change.
export type SessionPayload = { userId: string; pwv: number; sid: string };

export async function signSessionToken(
  payload: SessionPayload,
  expires: Date,
): Promise<string> {
  return new SignJWT({ pwv: payload.pwv, sid: payload.sid })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.userId)
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(secret());
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    if (
      typeof payload.sub !== "string" ||
      typeof payload.pwv !== "number" ||
      typeof payload.sid !== "string"
    ) {
      return null;
    }
    return { userId: payload.sub, pwv: payload.pwv, sid: payload.sid };
  } catch {
    return null;
  }
}
