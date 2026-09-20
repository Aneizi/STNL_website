import "server-only";
import { createHash } from "node:crypto";
import type { InterestInput } from "@/lib/colosseum-interest";
import { ensureBuilderRole } from "@/lib/hq/builder-role";
import { hitRateLimit } from "./rate-limit";

type InterestDb = {
  query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
};

const LIMIT = 20;
const RATE_LIMIT_ERROR = "Too many attempts. Please try again in 15 minutes.";
const UNAVAILABLE_ERROR = "We couldn't save your interest. Please try again shortly.";

/** Public submissions use the current edition, independently of operator cookies. */
async function currentHackathonId(db: InterestDb): Promise<number | null> {
  const [row] = await db.query(
    `SELECT id FROM hq_hackathons WHERE archived_at IS NULL
     ORDER BY (end_date >= current_date) DESC, start_date ASC LIMIT 1`,
  );
  return row ? Number(row.id) : null;
}

/** A stable UUID makes a repeated public submission insert-only, even after HQ edits it. */
function personId(input: InterestInput, hackathonId: number): string {
  const hash = createHash("sha256")
    .update(`colosseum-interest:${hackathonId}:${input.contactMethod}:${input.contact}`)
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
  const counter = await hitRateLimit(
    { query: async (text, params) => ({ rows: await db.query(text, params) }) },
    key,
    { max: LIMIT },
  );
  if (!counter.allowed) return { ok: false, error: RATE_LIMIT_ERROR };

  const hackathonId = await currentHackathonId(db);
  if (hackathonId === null) return { ok: false, error: UNAVAILABLE_ERROR };

  const roleId = await ensureBuilderRole(db);
  if (!roleId) return { ok: false, error: UNAVAILABLE_ERROR };

  const notes = `Built on Solana before: ${input.builtOnSolana ? "Yes" : "No"}`;

  // The person and activity are one atomic, insert-only write.
  await db.query(`
    WITH added AS (
      INSERT INTO hq_people (id, name, role_id, contact, notes, hackathon_id)
      VALUES ($1::uuid, $2, $3::uuid, $4, $5, $7)
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    )
    INSERT INTO hq_activity (message, hackathon_id)
    SELECT $6, $7 FROM added
  `, [
    personId(input, hackathonId), input.name, roleId, input.contact, notes,
    `${input.name} expressed interest in the Colosseum hackathon`,
    hackathonId,
  ]);
  return { ok: true };
}
