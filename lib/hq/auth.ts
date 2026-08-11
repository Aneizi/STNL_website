import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { getSql } from "./db";
import { readSession } from "./session";

export type HqUser = {
  id: string;
  username: string;
  displayName: string;
  mustChangePassword: boolean;
};

// The auth boundary. Layouts don't re-render on soft navigation, so this
// must run in every page, server action, and route handler — cache() makes
// repeated calls within one request free. The join against hq_sessions is
// what makes logout a real revocation: no row, no access, whatever the
// JWT says. expires_at bounds the absolute lifetime and last_seen_at
// enforces a 24-hour idle timeout server-side.
const loadUser = cache(async (): Promise<HqUser | null> => {
  const session = await readSession();
  if (!session) return null;
  const sql = getSql();
  const rows = (await sql`
    SELECT u.id, u.username, u.display_name, u.password_version,
      u.must_change_password, s.last_seen_at
    FROM hq_sessions s
    JOIN hq_users u ON u.id = s.user_id
    WHERE s.id = ${session.sid}
      AND s.user_id = ${session.userId}
      AND s.expires_at > now()
      AND s.last_seen_at > now() - interval '24 hours'
  `) as Array<{
    id: string;
    username: string;
    display_name: string;
    password_version: number;
    must_change_password: boolean;
    last_seen_at: string | Date;
  }>;
  const row = rows[0];
  if (!row || row.password_version !== session.pwv) return null;
  // Slide the idle window, throttled to at most one write per five minutes.
  if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60 * 1000) {
    await sql`UPDATE hq_sessions SET last_seen_at = now() WHERE id = ${session.sid}`;
  }
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    mustChangePassword: row.must_change_password,
  };
});

/** Nullable variant for places that respond with 401 instead of redirecting. */
export async function currentUser(): Promise<HqUser | null> {
  return loadUser();
}

/**
 * The gate every page opens with. It is a database round trip of its own, and
 * no page's reads depend on the identity, so pages start it *alongside* their
 * queries — `Promise.all([requireUser(), ...])` — rather than in front of them.
 * That keeps the check strictly before anything renders while taking its
 * latency off every navigation. An unauthenticated request still returns
 * nothing: the redirect rejects the group and the reads are discarded.
 */
export async function requireUser(opts?: { allowMustChange?: boolean }): Promise<HqUser> {
  const user = await loadUser();
  if (!user) redirect("/hq/login");
  if (user.mustChangePassword && !opts?.allowMustChange) redirect("/hq/change-password");
  return user;
}
