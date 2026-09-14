import "server-only";
import { createHash } from "node:crypto";
import type { InterestInput } from "@/lib/colosseum-interest";
import { ensureBuilderRole } from "@/lib/hq/builder-role";

type InterestDb = {
  query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
};

const LIMIT = 20;
const RATE_LIMIT_ERROR = "Too many attempts. Please try again in 15 minutes.";
const UNAVAILABLE_ERROR = "We couldn't save your interest. Please try again shortly.";

/**
 * The edition a public, unauthenticated submission belongs to: the same
 * server-side pick every other surface without an edition selector uses
 * (soonest-ending edition that has not ended, else the soonest upcoming one,
 * archived excluded). It used to be a hard-coded internal hq_hackathons.id
 * written into this module — exactly what the standing rule forbids, and a
 * row this form would have silently stopped writing the moment that edition
 * was archived.
 */
async function currentHackathonId(db: InterestDb): Promise<number | null> {
  const [row] = await db.query(
    `SELECT id FROM hq_hackathons WHERE archived_at IS NULL
     ORDER BY (end_date >= current_date) DESC, start_date ASC LIMIT 1`,
  );
  return row ? Number(row.id) : null;
}

/** A stable UUID makes a repeated public submission insert-only, even after HQ edits it. */
function personId(input: InterestInput, hackathonId: number | null): string {
  const hash = createHash("sha256")
    .update(`colosseum-interest:${hackathonId ?? "unscoped"}:${input.contactMethod}:${input.contact}`)
    .digest("hex")
    .slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20)}`;
}

export async function saveColosseumInterest(
  db: InterestDb,
  input: InterestInput,
  source: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Reuse the existing fixed-window counters with a separate namespace.
  // Store a hash so contact data and network addresses never enter the key.
  const sourceHash = createHash("sha256").update(source.slice(0, 200)).digest("hex");
  const key = `colosseum-interest:ip:${sourceHash}`;
  await db.query(`
    DELETE FROM hq_login_limits
    WHERE key LIKE 'colosseum-interest:ip:%'
      AND window_start < now() - interval '1 day'
  `);
  const [counter] = await db.query(`
    INSERT INTO hq_login_limits AS l (key, count, window_start)
    VALUES ($1, 1, now())
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN l.window_start < now() - interval '15 minutes'
        THEN 1 ELSE least(l.count + 1, $2::int + 1) END,
      window_start = CASE WHEN l.window_start < now() - interval '15 minutes'
        THEN now() ELSE l.window_start END
    RETURNING count
  `, [key, LIMIT]);
  if (Number(counter.count) > LIMIT) return { ok: false, error: RATE_LIMIT_ERROR };

  // The public flow works with both the original HQ schema and its scoped
  // successor. Never use an admin's selection cookie for a public signup.
  const [capabilities] = await db.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'hq_people' AND column_name = 'hackathon_id'
    ) AS scoped
  `);
  const scoped = capabilities.scoped === true;
  const hackathonId = scoped ? await currentHackathonId(db) : null;
  if (scoped && hackathonId === null) return { ok: false, error: UNAVAILABLE_ERROR };

  const roleId = await ensureBuilderRole(db);
  if (!roleId) return { ok: false, error: UNAVAILABLE_ERROR };

  const notes = `Built on Solana before: ${input.builtOnSolana ? "Yes" : "No"}`;

  // Only these fixed fragments vary by the capability check; all submitted
  // data stays parameterized. The person and activity are one atomic write.
  await db.query(`
    WITH added AS (
      INSERT INTO hq_people (id, name, role_id, contact, notes${scoped ? ", hackathon_id" : ""})
      VALUES ($1::uuid, $2, $3::uuid, $4, $5${scoped ? ", $7" : ""})
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    )
    INSERT INTO hq_activity (message${scoped ? ", hackathon_id" : ""})
    SELECT $6${scoped ? ", $7" : ""} FROM added
  `, [
    personId(input, hackathonId), input.name, roleId, input.contact, notes,
    `${input.name} expressed interest in the Colosseum hackathon`,
    ...(scoped ? [hackathonId] : []),
  ]);
  return { ok: true };
}
