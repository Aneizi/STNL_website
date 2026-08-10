"use server";

import bcrypt from "bcryptjs";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "../auth";
import { getSql } from "../db";
import { createSession, destroySession } from "../session";
import type { ActionResult } from "../types";

const GENERIC_ERROR = "Invalid username or password.";
const THROTTLE_ERROR = "Too many attempts. Try again in a few minutes.";

// Fixed 15-minute limiter windows. The per-source cap is keyed by username
// AND address, so a remote attacker burning attempts on a known username
// cannot lock the real operator out from their own connection.
const USER_IP_MAX_ATTEMPTS = 5;
const IP_MAX_ATTEMPTS = 20;

// Compared against when the username doesn't exist, so response timing
// doesn't reveal which usernames are real.
let dummyHash: string | null = null;
function getDummyHash(): string {
  if (!dummyHash) dummyHash = bcrypt.hashSync("hq-timing-pad", 12);
  return dummyHash;
}

// Atomic fixed-window counter bump: one upserted row per key, updated in
// place, so a source that stays blocked only ever rewrites its own row —
// the table cannot grow however hard the endpoint is hammered. Concurrent
// bursts serialize on the row lock and are counted exactly.
async function bumpLimit(key: string): Promise<number> {
  const sql = getSql();
  const [row] = await sql`
    INSERT INTO hq_login_limits AS l (key, count, window_start)
    VALUES (${key}, 1, now())
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN l.window_start < now() - interval '15 minutes'
        THEN 1 ELSE l.count + 1 END,
      window_start = CASE WHEN l.window_start < now() - interval '15 minutes'
        THEN now() ELSE l.window_start END
    RETURNING count
  `;
  return Number(row.count);
}

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

// username is echoed back so the form can repopulate the field after
// React's automatic post-action reset.
export type LoginResult = ActionResult & { username?: string };

export async function login(
  _prev: LoginResult | null,
  formData: FormData,
): Promise<LoginResult> {
  const parsed = loginSchema.safeParse({
    username: formData.get("username"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: GENERIC_ERROR,
      username: String(formData.get("username") ?? "").slice(0, 64),
    };
  }
  const username = parsed.data.username.trim().toLowerCase();

  const sql = getSql();
  const headerStore = await headers();
  // Vercel sets both headers itself, so they cannot be client-spoofed
  // there. Anywhere else, unattributable traffic shares one bucket.
  const ip =
    headerStore.get("x-real-ip") ??
    headerStore.get("x-forwarded-for")?.split(",")[0].trim() ??
    "unknown";

  // Both caps are checked before any bcrypt work or append-only write —
  // a blocked request costs one counter update and nothing else.
  if ((await bumpLimit(`ip:${ip}`)) > IP_MAX_ATTEMPTS) {
    return { ok: false, error: THROTTLE_ERROR, username: parsed.data.username };
  }
  if ((await bumpLimit(`user:${username}@${ip}`)) > USER_IP_MAX_ATTEMPTS) {
    return { ok: false, error: THROTTLE_ERROR, username: parsed.data.username };
  }

  const rows = await sql`
    SELECT id, password_hash, password_version, must_change_password
    FROM hq_users
    WHERE username = ${username}
  `;
  const user = rows[0];
  const valid = user
    ? await bcrypt.compare(parsed.data.password, user.password_hash)
    : (await bcrypt.compare(parsed.data.password, getDummyHash()), false);

  // Audit trail — written only for requests that passed the limiter, with
  // retention enforced on the same path (both deletes are index/PK-backed).
  await sql`
    INSERT INTO hq_login_attempts (username, ip, success)
    VALUES (${username}, ${ip}, ${valid})
  `;
  await sql`DELETE FROM hq_login_attempts WHERE created_at < now() - interval '1 day'`;
  await sql`DELETE FROM hq_login_limits WHERE window_start < now() - interval '1 day'`;

  if (!user || !valid) {
    return { ok: false, error: GENERIC_ERROR, username: parsed.data.username };
  }

  // Both counters are bumped before the password is checked so a concurrent
  // burst can't slip past the caps; a success gives its credit back, leaving
  // the windows counting failures only. Otherwise a whole team behind one
  // office address could exhaust the shared budget just by signing in.
  await sql`DELETE FROM hq_login_limits WHERE key = ${`user:${username}@${ip}`}`;
  await sql`
    UPDATE hq_login_limits SET count = greatest(count - 1, 0)
    WHERE key = ${`ip:${ip}`}
  `;
  await sql`
    DELETE FROM hq_sessions
    WHERE expires_at < now() OR last_seen_at < now() - interval '24 hours'
  `;

  await createSession(user.id, user.password_version);
  redirect(user.must_change_password ? "/hq/change-password" : "/hq");
}

export async function changePassword(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser({ allowMustChange: true });
  const password = formData.get("password");
  const confirm = formData.get("confirm");
  if (typeof password !== "string" || password.length < 12 || password.length > 256) {
    return { ok: false, error: "Password must be at least 12 characters." };
  }
  if (password !== confirm) {
    return { ok: false, error: "Passwords do not match." };
  }

  const sql = getSql();
  const hash = await bcrypt.hash(password, 12);
  const rows = await sql`
    UPDATE hq_users
    SET password_hash = ${hash},
        must_change_password = false,
        password_version = password_version + 1
    WHERE id = ${user.id}
    RETURNING password_version
  `;
  // Revoke every existing session server-side; the password_version bump
  // additionally invalidates any token already issued.
  await sql`DELETE FROM hq_sessions WHERE user_id = ${user.id}`;
  await createSession(user.id, rows[0].password_version);
  redirect("/hq");
}

export async function logout() {
  await destroySession();
  redirect("/hq/login");
}
