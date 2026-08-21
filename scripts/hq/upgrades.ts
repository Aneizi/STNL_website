// Upgrades for databases created before the demo-day integrity constraints.
// Fresh databases get that shape straight from schema.sql; every step here
// checks state first (or uses IF EXISTS both ways), so re-runs — including
// re-runs after a mid-upgrade crash — are no-ops.
//
// Split from migrate.ts so tests can drive it against a throwaway Postgres:
// it only needs `query(text) => rows`, which both the Neon driver and a
// test harness satisfy.
export type SqlRunner = {
  query: (text: string) => Promise<Record<string, unknown>[]>;
};

export async function applyUpgrades(sql: SqlRunner) {
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

  // Finalist positions must be unique so concurrent max+1 inserts cannot
  // assign the same slot. Fresh databases already have this index under the
  // same name (schema.sql's inline UNIQUE), so the check skips them; on an
  // older database the rows are renumbered first, because the duplicates
  // this constraint exists to prevent would otherwise abort the build.
  // Renumbering before the index avoids transient collisions mid-UPDATE.
  const [positionIndex] = await sql.query(
    `SELECT to_regclass('hq_finalists_position_key') AS idx`,
  );
  if (!positionIndex?.idx) {
    await sql.query(`
      UPDATE hq_finalists f SET position = r.rn::int
      FROM (
        SELECT project_id, row_number() OVER (ORDER BY position, project_id) AS rn
        FROM hq_finalists
      ) r
      WHERE r.project_id = f.project_id AND f.position <> r.rn
    `);
    await sql.query(
      `CREATE UNIQUE INDEX hq_finalists_position_key ON hq_finalists (position)`,
    );
  }

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
}
