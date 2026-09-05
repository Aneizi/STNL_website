import "server-only";
import { createHash } from "node:crypto";
import type { InterestInput } from "@/lib/colosseum-interest";

type InterestDb = {
  query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
};

const HACKATHON_ID = 6;
const LIMIT = 20;
const RATE_LIMIT_ERROR = "Too many attempts. Please try again in 15 minutes.";
const UNAVAILABLE_ERROR = "We couldn't save your interest. Please try again shortly.";

/** A stable UUID makes a repeated public submission insert-only, even after HQ edits it. */
function personId(input: InterestInput): string {
  const hash = createHash("sha256")
    .update(`colosseum-interest:${HACKATHON_ID}:${input.contactMethod}:${input.contact}`)
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
  if (scoped) {
    const hackathons = await db.query(
      `SELECT id FROM hq_hackathons WHERE id = $1 AND archived_at IS NULL`,
      [HACKATHON_ID],
    );
    if (!hackathons[0]) return { ok: false, error: UNAVAILABLE_ERROR };
  }

  await db.query(`
    INSERT INTO hq_people_roles (label, filter_label, color, bg, is_judge, sort)
    VALUES ('Interested builder', 'Interested builders', 'accent', 'accent-fill', false, 100)
    ON CONFLICT (label) DO NOTHING
  `);
  const [role] = await db.query(`
    SELECT id FROM hq_people_roles WHERE label = 'Interested builder' AND NOT is_judge
  `);
  if (!role) return { ok: false, error: UNAVAILABLE_ERROR };

  const notes = [
    "Colosseum hackathon interest",
    `Path: ${input.path === "beginner" ? "Beginner" : "Experienced"}`,
    `Built on Solana before: ${input.builtOnSolana ? "Yes" : "No"}`,
  ].join("\n");
  const contact = input.contactMethod === "telegram"
    ? `Telegram: ${input.contact}`
    : `Phone: ${input.contact}`;

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
    personId(input), input.name, role.id, contact, notes,
    `${input.name} expressed interest in the Colosseum hackathon`,
    ...(scoped ? [HACKATHON_ID] : []),
  ]);
  return { ok: true };
}
