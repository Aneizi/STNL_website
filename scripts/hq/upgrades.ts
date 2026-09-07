// Upgrades for databases created before the demo-day integrity constraints
// and, later, before HQ became hackathon-agnostic. Fresh databases get the
// final shape straight from schema.sql; every step here checks state first
// (or uses IF EXISTS both ways), so re-runs — including re-runs after a
// mid-upgrade crash — are no-ops.
//
// Split from migrate.ts so tests can drive it against a throwaway Postgres:
// it only needs `query(text) => rows`, which both the Neon driver and a
// test harness satisfy.
import { ensureBuilderRole } from "../../lib/hq/builder-role";

export type SqlRunner = {
  query: (text: string) => Promise<Record<string, unknown>[]>;
};

/**
 * The edition every pre-hackathon database is carrying without saying so.
 * The backfill below files all of its existing data under this hackathon;
 * afterwards the row is ordinary data, editable in Admin like any other.
 * The id is a legacy internal HQ key. External Colosseum IDs are configured
 * independently in hq_hackathon_onboarding after they have been confirmed.
 */
export const FIRST_HACKATHON = {
  id: 6,
  slug: "colosseum-worlds-fair",
  name: "Colosseum World's Fair",
  startDate: "2026-09-14",
  endDate: "2026-10-12",
} as const;

/**
 * Tables that carry a hackathon_id, in dependency order: hq_finalists copies
 * its value from hq_projects, so projects must be scoped first.
 */
export const HACKATHON_SCOPED_TABLES = [
  "hq_partners",
  "hq_projects",
  "hq_people",
  "hq_events",
  "hq_links",
  "hq_milestones",
  "hq_awards",
  "hq_activity",
  "hq_submission_gates",
  "hq_settings",
  "hq_finalists",
] as const;

async function columnInfo(
  sql: SqlRunner,
  table: string,
  column: string,
): Promise<{ exists: boolean; nullable: boolean }> {
  const rows = await sql.query(`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = '${table}' AND column_name = '${column}'
  `);
  if (rows.length === 0) return { exists: false, nullable: true };
  return { exists: true, nullable: rows[0].is_nullable === "YES" };
}

export async function applyUpgrades(sql: SqlRunner) {
  await ensureBuilderRole(sql);

  // "Other" lets operators capture roles outside the fixed taxonomy. The
  // People form stores the clarification in the person's existing notes.
  await sql.query(`
    INSERT INTO hq_people_roles
      (label, filter_label, color, bg, is_judge, sort)
    VALUES ('Other', 'Other', 'label-2', 'fill-4', false, 4)
    ON CONFLICT (label) DO UPDATE SET
      filter_label = EXCLUDED.filter_label,
      color = EXCLUDED.color,
      bg = EXCLUDED.bg,
      is_judge = EXCLUDED.is_judge,
      sort = EXCLUDED.sort
  `);

  // "Rejected" closes out partner conversations that fell through, so they
  // stop lingering in the pipeline columns. Databases seeded before it
  // existed get the stage here; the board tints it red next to Agreed.
  await sql.query(`
    INSERT INTO hq_partner_stages (slug, label, drop_color, sort)
    VALUES ('rejected', 'Rejected', '#c03b2d', 4)
    ON CONFLICT (slug) DO UPDATE SET
      label = EXCLUDED.label,
      drop_color = EXCLUDED.drop_color,
      sort = EXCLUDED.sort
  `);

  // The "mailing" exchange item outgrew mailing lists — the exchange it
  // tracks is any communication with the partner's community.
  await sql.query(`
    UPDATE hq_exchange_items SET label = 'Communicated with community members'
    WHERE slug = 'mailing'
  `);

  // The "call" stage rarely means an actual call — what it marks is that the
  // partner replied. The slug stays, so existing partners keep their stage.
  await sql.query(`
    UPDATE hq_partner_stages SET label = 'Replied'
    WHERE slug = 'call'
  `);

  // The submission gates were reworded and reordered to follow the run a team
  // actually makes: register, then build, then submit. Renaming in place (by
  // the old label) keeps hq_project_gates rows pointing at the same gate, so
  // teams don't lose the boxes they already ticked. "Colosseum URL verified"
  // split in two — the rename keeps it as the closing submission gate and the
  // registration gate is inserted fresh. Each statement is keyed on the old
  // label, so a re-run after the rename matches nothing and changes nothing.
  //
  // Only pre-hackathon databases run this: once gates belong to a hackathon
  // they are that edition's own list, edited in Admin, and this rework
  // (which knows nothing of hackathons) would fight it.
  const gatesScoped = await columnInfo(sql, "hq_submission_gates", "hackathon_id");
  if (!gatesScoped.exists) {
    const GATE_RENAMES: [string, string][] = [
      ["Team profiles complete", "Social profile"],
      ["Working MVP of core flow", "Working MVP"],
      ["Solana rationale written", "Solana rationale established"],
      ["Colosseum URL verified", "Colosseum submission"],
    ];
    for (const [before, after] of GATE_RENAMES) {
      await sql.query(`
        UPDATE hq_submission_gates SET label = '${after}'
        WHERE label = '${before}'
          AND NOT EXISTS (
            SELECT 1 FROM hq_submission_gates existing WHERE existing.label = '${after}')
      `);
    }
    // Only databases carrying this gate set get the new registration gate;
    // one keyed on other labels (a test fixture, a differently seeded campaign)
    // is left alone.
    await sql.query(`
      INSERT INTO hq_submission_gates (label, sort)
      SELECT 'Colosseum registration', 0
      WHERE EXISTS (SELECT 1 FROM hq_submission_gates WHERE label = 'Colosseum submission')
      ON CONFLICT (label) DO NOTHING
    `);
    // Re-sort every gate that survives under its new name; gates an operator
    // added themselves keep their own order after these.
    const GATE_ORDER = [
      "Colosseum registration",
      "Social profile",
      "Solana rationale established",
      "Working MVP",
      "Repo accessible",
      "Validation evidence",
      "Pitch video, 2 min max",
      "Technical video, 2 min max",
      "All links tested",
      "Colosseum submission",
    ];
    for (const [i, label] of GATE_ORDER.entries()) {
      await sql.query(
        `UPDATE hq_submission_gates SET sort = ${i} WHERE label = '${label}'`,
      );
    }
  }

  // Timeline notes became editable; edited_at carries the "(edited)" marker.
  await sql.query(`
    ALTER TABLE hq_project_notes ADD COLUMN IF NOT EXISTS edited_at timestamptz
  `);

  // Award winners must reference current finalists (clears on removal).
  const awardsFk = await sql.query(`
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'hq_awards'::regclass AND contype = 'f'
      AND confrelid = 'hq_finalists'::regclass
  `);
  if (awardsFk.length === 0) {
    await sql.query(`
      UPDATE hq_awards SET winner_project_id = NULL
      WHERE winner_project_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM hq_finalists f
                        WHERE f.project_id = hq_awards.winner_project_id)
    `);
    await sql.query(
      `ALTER TABLE hq_awards DROP CONSTRAINT IF EXISTS hq_awards_winner_project_id_fkey`,
    );
    await sql.query(`
      ALTER TABLE hq_awards ADD CONSTRAINT hq_awards_winner_project_id_fkey
      FOREIGN KEY (winner_project_id) REFERENCES hq_finalists (project_id)
      ON DELETE SET NULL
    `);
    console.log("Upgraded hq_awards: winners now reference finalists.");
  }

  // Scores: judge_name (mutable, non-unique text) → judge_id (stable person
  // id), scoped to finalists, at most one score per judge and project.
  const judgeNameCol = await sql.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'hq_scores' AND column_name = 'judge_name'
  `);
  if (judgeNameCol.length > 0) {
    await sql.query(`ALTER TABLE hq_scores ADD COLUMN IF NOT EXISTS judge_id uuid`);
    await sql.query(`
      UPDATE hq_scores SET judge_id = p.id FROM hq_people p
      WHERE hq_scores.judge_id IS NULL AND p.name = hq_scores.judge_name
    `);
    const dropped = await sql.query(`
      DELETE FROM hq_scores
      WHERE judge_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM hq_finalists f
                        WHERE f.project_id = hq_scores.project_id)
      RETURNING id
    `);
    // Keep only the newest score per judge/project before the unique pair.
    await sql.query(`
      DELETE FROM hq_scores AS s
      USING hq_scores AS newer
      WHERE newer.judge_id = s.judge_id AND newer.project_id = s.project_id
        AND (newer.created_at > s.created_at
             OR (newer.created_at = s.created_at AND newer.id > s.id))
    `);
    await sql.query(`ALTER TABLE hq_scores ALTER COLUMN judge_id SET NOT NULL`);
    await sql.query(`ALTER TABLE hq_scores DROP CONSTRAINT IF EXISTS hq_scores_judge_id_fkey`);
    await sql.query(`
      ALTER TABLE hq_scores ADD CONSTRAINT hq_scores_judge_id_fkey
      FOREIGN KEY (judge_id) REFERENCES hq_people (id) ON DELETE CASCADE
    `);
    await sql.query(`ALTER TABLE hq_scores DROP CONSTRAINT IF EXISTS hq_scores_project_id_fkey`);
    await sql.query(`
      ALTER TABLE hq_scores ADD CONSTRAINT hq_scores_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES hq_finalists (project_id) ON DELETE CASCADE
    `);
    await sql.query(
      `ALTER TABLE hq_scores DROP CONSTRAINT IF EXISTS hq_scores_judge_id_project_id_key`,
    );
    await sql.query(`
      ALTER TABLE hq_scores ADD CONSTRAINT hq_scores_judge_id_project_id_key
      UNIQUE (judge_id, project_id)
    `);
    await sql.query(`ALTER TABLE hq_scores DROP COLUMN judge_name`);
    console.log(
      `Upgraded hq_scores to judge ids${
        dropped.length > 0
          ? ` (${dropped.length} rows without a matching judge or finalist removed)`
          : ""
      }.`,
    );
  }

  // Team members: hq_projects.members (comma-joined text[], no contacts) →
  // hq_project_members rows, individually editable with a contact each.
  // Order is preserved in sort; contacts start empty. The NOT EXISTS guard
  // makes a re-run after a mid-upgrade crash skip already-migrated projects.
  const membersCol = await sql.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'hq_projects' AND column_name = 'members'
  `);
  if (membersCol.length > 0) {
    await sql.query(`
      INSERT INTO hq_project_members (project_id, name, contact, sort)
      SELECT p.id, m.name, '', m.ord::int
      FROM hq_projects p, unnest(p.members) WITH ORDINALITY AS m(name, ord)
      WHERE NOT EXISTS (
        SELECT 1 FROM hq_project_members pm WHERE pm.project_id = p.id
      )
    `);
    await sql.query(`ALTER TABLE hq_projects DROP COLUMN members`);
    console.log("Upgraded hq_projects: members moved to hq_project_members.");
  }

  // Luma mirroring. Fresh databases get these from schema.sql; the ADD COLUMN
  // IF NOT EXISTS form makes the statements no-ops there and on re-runs.
  await sql.query(`
    ALTER TABLE hq_events
      ADD COLUMN IF NOT EXISTS luma_id text,
      ADD COLUMN IF NOT EXISTS luma_url text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS pinned_fields text[] NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS archived_at timestamptz,
      ADD COLUMN IF NOT EXISTS archived_reason text
  `);
  // UNIQUE and CHECK cannot ride along with ADD COLUMN IF NOT EXISTS, so they
  // are added separately and only when absent.
  const [lumaIdIndex] = await sql.query(`SELECT to_regclass('hq_events_luma_id_key') AS idx`);
  if (!lumaIdIndex?.idx) {
    await sql.query(`CREATE UNIQUE INDEX hq_events_luma_id_key ON hq_events (luma_id)`);
  }
  const archivedReasonCheck = await sql.query(`
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'hq_events'::regclass AND conname = 'hq_events_archived_reason_check'
  `);
  if (archivedReasonCheck.length === 0) {
    await sql.query(`
      ALTER TABLE hq_events ADD CONSTRAINT hq_events_archived_reason_check
      CHECK (archived_reason IN ('manual', 'missing'))
    `);
  }

  await sql.query(`
    CREATE TABLE IF NOT EXISTS hq_luma_sync (
      id boolean PRIMARY KEY DEFAULT true CHECK (id),
      last_success_at timestamptz NOT NULL DEFAULT 'epoch'
    )
  `);
  // The sync locks this row, so it has to exist before the first sync runs.
  await sql.query(`INSERT INTO hq_luma_sync (id) VALUES (true) ON CONFLICT DO NOTHING`);

  await applyHackathonScoping(sql);
}

/**
 * HQ became hackathon-agnostic: every operational table gained a NOT NULL
 * hackathon_id. A database from before then holds exactly one edition's data
 * without naming it, so the upgrade creates that edition (FIRST_HACKATHON)
 * when there is anything to file under it, and backfills every row to it.
 *
 * Each table is handled on its own — column present, backfilled, NOT NULL —
 * so a run interrupted halfway resumes where it stopped. hq_finalists takes
 * its hackathon from the project rather than the fallback, which is why it
 * comes after hq_projects in HACKATHON_SCOPED_TABLES.
 */
async function applyHackathonScoping(sql: SqlRunner) {
  await sql.query(`
    CREATE TABLE IF NOT EXISTS hq_hackathons (
      id int PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      name text NOT NULL,
      start_date date NOT NULL,
      end_date date NOT NULL,
      archived_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (end_date >= start_date)
    )
  `);
  // Archiving arrived after the table; a database created without the column
  // gains it here, still NULL for every edition (archiving is manual only).
  await sql.query(`ALTER TABLE hq_hackathons ADD COLUMN IF NOT EXISTS archived_at timestamptz`);

  const pending: string[] = [];
  for (const table of HACKATHON_SCOPED_TABLES) {
    const col = await columnInfo(sql, table, "hackathon_id");
    if (!col.exists || col.nullable) pending.push(table);
  }

  if (pending.length > 0) {
    // Only a database that actually holds unscoped rows needs the first
    // edition created for it; an empty one (a fresh test database, say) gets
    // its hackathons from the seed instead.
    const [{ has_rows: hasRows }] = await sql.query(
      `SELECT (${pending
        .filter((t) => t !== "hq_finalists")
        .map((t) => `EXISTS (SELECT 1 FROM ${t})`)
        .join(" OR ") || "false"}) AS has_rows`,
    );
    if (hasRows) {
      await sql.query(`
        INSERT INTO hq_hackathons (id, slug, name, start_date, end_date)
        SELECT ${FIRST_HACKATHON.id}, '${FIRST_HACKATHON.slug}',
               '${FIRST_HACKATHON.name.replace(/'/g, "''")}',
               '${FIRST_HACKATHON.startDate}', '${FIRST_HACKATHON.endDate}'
        WHERE NOT EXISTS (SELECT 1 FROM hq_hackathons)
      `);
    }
    const [fallback] = await sql.query(
      `SELECT id FROM hq_hackathons ORDER BY start_date, created_at LIMIT 1`,
    );
    const fallbackId = fallback ? Number(fallback.id) : null;

    for (const table of pending) {
      await sql.query(`
        ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS hackathon_id int
          REFERENCES hq_hackathons (id) ON DELETE CASCADE
      `);
      if (table === "hq_finalists") {
        await sql.query(`
          UPDATE hq_finalists f SET hackathon_id = p.hackathon_id
          FROM hq_projects p
          WHERE p.id = f.project_id AND f.hackathon_id IS NULL
        `);
      } else if (fallbackId !== null) {
        await sql.query(`
          UPDATE ${table} SET hackathon_id = ${fallbackId} WHERE hackathon_id IS NULL
        `);
      }
      await sql.query(`ALTER TABLE ${table} ALTER COLUMN hackathon_id SET NOT NULL`);
    }
    console.log(
      `Upgraded ${pending.length} table${pending.length > 1 ? "s" : ""} to hackathon scoping.`,
    );
  }

  for (const [table, columns] of [
    ["hq_partners", "hackathon_id"],
    ["hq_projects", "hackathon_id"],
    ["hq_people", "hackathon_id"],
    ["hq_events", "hackathon_id, date"],
    ["hq_activity", "hackathon_id, created_at DESC"],
    ["hq_links", "hackathon_id"],
  ]) {
    await sql.query(`CREATE INDEX IF NOT EXISTS ${table}_hackathon_idx ON ${table} (${columns})`);
  }

  // Settings are keyed per hackathon now: (hackathon_id, key) replaces (key).
  const settingsPk = await sql.query(`
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'hq_settings'::regclass AND c.contype = 'p'
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
          AND a.attname = 'hackathon_id')
  `);
  if (settingsPk.length === 0) {
    await sql.query(`ALTER TABLE hq_settings DROP CONSTRAINT IF EXISTS hq_settings_pkey`);
    await sql.query(`ALTER TABLE hq_settings ADD PRIMARY KEY (hackathon_id, key)`);
  }

  // Gate labels are unique within a hackathon, not across the whole table.
  await sql.query(`
    ALTER TABLE hq_submission_gates DROP CONSTRAINT IF EXISTS hq_submission_gates_label_key
  `);
  const [gatesKey] = await sql.query(
    `SELECT to_regclass('hq_submission_gates_hackathon_id_label_key') AS idx`,
  );
  if (!gatesKey?.idx) {
    await sql.query(`
      ALTER TABLE hq_submission_gates
      ADD CONSTRAINT hq_submission_gates_hackathon_id_label_key UNIQUE (hackathon_id, label)
    `);
  }

  // Gates are deletable in Admin now, so a deleted gate must take its ticks
  // with it instead of being refused by the foreign key.
  const [gateFk] = await sql.query(`
    SELECT conname, confdeltype FROM pg_constraint
    WHERE conrelid = 'hq_project_gates'::regclass AND contype = 'f'
      AND confrelid = 'hq_submission_gates'::regclass
  `);
  if (gateFk && gateFk.confdeltype !== "c") {
    await sql.query(`ALTER TABLE hq_project_gates DROP CONSTRAINT ${String(gateFk.conname)}`);
    await sql.query(`
      ALTER TABLE hq_project_gates ADD CONSTRAINT hq_project_gates_gate_id_fkey
      FOREIGN KEY (gate_id) REFERENCES hq_submission_gates (id) ON DELETE CASCADE
    `);
  }

  // Finalist positions must be unique per hackathon so concurrent max+1
  // inserts cannot assign the same slot. Fresh databases already have this
  // constraint under the same name (schema.sql's inline UNIQUE), so the check
  // skips them; on an older database the rows are renumbered first, because
  // the duplicates this constraint exists to prevent would otherwise abort
  // the build. Renumbering before the index avoids transient collisions.
  const [positionKey] = await sql.query(
    `SELECT to_regclass('hq_finalists_hackathon_id_position_key') AS idx`,
  );
  if (!positionKey?.idx) {
    await sql.query(`
      UPDATE hq_finalists f SET position = r.rn::int
      FROM (
        SELECT project_id,
          row_number() OVER (PARTITION BY hackathon_id ORDER BY position, project_id) AS rn
        FROM hq_finalists
      ) r
      WHERE r.project_id = f.project_id AND f.position <> r.rn
    `);
    // The global unique came either as a constraint (older schema.sql) or as
    // a bare index (the earlier upgrade); IF EXISTS covers both shapes.
    await sql.query(`ALTER TABLE hq_finalists DROP CONSTRAINT IF EXISTS hq_finalists_position_key`);
    await sql.query(`DROP INDEX IF EXISTS hq_finalists_position_key`);
    await sql.query(`
      ALTER TABLE hq_finalists
      ADD CONSTRAINT hq_finalists_hackathon_id_position_key UNIQUE (hackathon_id, position)
    `);
  }
}
