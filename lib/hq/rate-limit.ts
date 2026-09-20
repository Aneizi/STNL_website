import "server-only";
import type { Query } from "./db";

/** One atomic, bounded counter per key. Callers own their key namespace. */
export async function hitRateLimit(
  db: Query,
  key: string,
  { max, windowMinutes = 15 }: { max: number; windowMinutes?: number },
): Promise<{ allowed: boolean; count: number }> {
  const { rows } = await db.query(
    `INSERT INTO hq_login_limits AS l (key, count, window_start)
     VALUES ($1, 1, now())
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN l.window_start < now() - $3 * interval '1 minute'
         THEN 1 ELSE least(l.count + 1, $2::int + 1) END,
       window_start = CASE WHEN l.window_start < now() - $3 * interval '1 minute'
         THEN now() ELSE l.window_start END
     RETURNING count`,
    [key, max, windowMinutes],
  );
  const count = Number(rows[0].count);
  return { allowed: count <= max, count };
}

/** A successful login clears its user counter and credits its shared IP counter. */
export async function releaseRateLimit(db: Query, key: string, reset = false): Promise<void> {
  await db.query(
    reset ? "DELETE FROM hq_login_limits WHERE key = $1"
      : "UPDATE hq_login_limits SET count = greatest(count - 1, 0) WHERE key = $1",
    [key],
  );
}

/** Indexed, bounded retention belongs to scheduled work, not public requests. */
export async function purgeExpiredLoginState(db: Query, now = Date.now(), limit = 500): Promise<void> {
  const cutoff = new Date(now - 24 * 60 * 60_000).toISOString();
  const batch = Math.max(1, Math.min(5_000, Math.floor(limit)));
  await db.query(
    `DELETE FROM hq_login_limits WHERE key IN (
       SELECT key FROM hq_login_limits WHERE window_start < $1::timestamptz
       ORDER BY window_start, key LIMIT $2 FOR UPDATE SKIP LOCKED
     )`,
    [cutoff, batch],
  );
  await db.query(
    `DELETE FROM hq_login_attempts WHERE id IN (
       SELECT id FROM hq_login_attempts WHERE created_at < $1::timestamptz
       ORDER BY created_at, id LIMIT $2 FOR UPDATE SKIP LOCKED
     )`,
    [cutoff, batch],
  );
}
