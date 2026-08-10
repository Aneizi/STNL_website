import "server-only";
import { cookies } from "next/headers";
import { getSql } from "./db";
import { signSessionToken, verifySessionToken, type SessionPayload } from "./session-token";

export type { SessionPayload };

const COOKIE = "hq_session";
// Absolute lifetime; lib/hq/auth.ts additionally enforces a 24-hour idle
// timeout against hq_sessions.last_seen_at.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function createSession(userId: string, passwordVersion: number) {
  const expires = new Date(Date.now() + MAX_AGE_MS);
  const sql = getSql();
  const [row] = await sql`
    INSERT INTO hq_sessions (user_id, expires_at)
    VALUES (${userId}, ${expires.toISOString()})
    RETURNING id
  `;
  const token = await signSessionToken(
    { userId, pwv: passwordVersion, sid: row.id },
    expires,
  );
  const store = await cookies();
  store.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires,
  });
}

export async function readSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

export async function destroySession() {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (token) {
    const session = await verifySessionToken(token);
    if (session) {
      // Server-side revocation: a copied token dies here too, instead of
      // staying valid until its JWT expiry.
      const sql = getSql();
      await sql`DELETE FROM hq_sessions WHERE id = ${session.sid}`;
    }
  }
  store.delete(COOKIE);
}
