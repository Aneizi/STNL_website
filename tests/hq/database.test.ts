// Integration tests for the parts of HQ the database itself has to get
// right: the migration path, the demo-day invariants, the login limiter,
// and session revocation. They run against a real Postgres (PGlite, the
// engine compiled to WASM) so constraints, cascades, and upsert semantics
// are genuinely exercised rather than mocked.
//
// The runtime statements are copied from lib/hq/actions/*; that keeps the
// tests honest about schema shape (a renamed column fails here) without
// needing a Next.js request context to call the Server Actions.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { applyUpgrades } from "@/scripts/hq/upgrades";

const SCHEMA = readFileSync(join(process.cwd(), "scripts/hq/schema.sql"), "utf8");

/** Exactly how scripts/hq/migrate.ts splits the file for the HTTP driver. */
function statements(text: string): string[] {
  return text
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

type Row = Record<string, string | number | boolean | null>;

type Db = {
  query: (text: string, params?: unknown[]) => Promise<Row[]>;
};

function connect(): Db {
  const pg = new PGlite();
  return {
    query: async (text, params) => (await pg.query(text, params)).rows as Row[],
  };
}

async function migrate(db: Db) {
  for (const statement of statements(SCHEMA)) await db.query(statement);
  await applyUpgrades({ query: (text) => db.query(text) });
}

/** Minimum rows every screen depends on: roles, classifiers, people, projects. */
async function seed(db: Db) {
  await db.query(
    `INSERT INTO hq_people_roles (label, filter_label, color, bg, is_judge, sort)
     VALUES ('Judge','Judges','indigo','fill-3',true,0),
            ('Captain','Captains','accent','accent-fill',false,1)`,
  );
  await db.query(
    `INSERT INTO hq_project_statuses (slug,label,color,counts_as_active,sort)
     VALUES ('green','Green','green',true,0)`,
  );
  await db.query(
    `INSERT INTO hq_project_forecasts (slug,label,color,sort) VALUES ('committed','Committed','green',0)`,
  );
  await db.query(`INSERT INTO hq_submission_gates (label, sort) VALUES ('G1',0), ('G2',1)`);
  const [judgeRole] = await db.query(`SELECT id FROM hq_people_roles WHERE is_judge`);
  const [captainRole] = await db.query(`SELECT id FROM hq_people_roles WHERE NOT is_judge`);
  await db.query(
    `INSERT INTO hq_people (name, role_id) VALUES ('Judge One',$1),('Judge Two',$1),('Cappy',$2)`,
    [judgeRole.id, captainRole.id],
  );
  const [status] = await db.query(`SELECT id FROM hq_project_statuses`);
  const [forecast] = await db.query(`SELECT id FROM hq_project_forecasts`);
  await db.query(
    `INSERT INTO hq_projects (name, status_id, forecast_id, last_check_in)
     VALUES ('P1',$1,$2,current_date), ('P2',$1,$2,current_date),
            ('P3',$1,$2,current_date), ('P4',$1,$2,current_date)`,
    [status.id, forecast.id],
  );
  await db.query(
    `INSERT INTO hq_users (username, display_name, password_hash) VALUES ('alex','Alex','x')`,
  );
}

async function byName(db: Db, table: string): Promise<Record<string, string>> {
  const rows = await db.query(`SELECT id, name FROM ${table}`);
  return Object.fromEntries(rows.map((r) => [r.name, r.id]));
}

// The statements under test, mirroring lib/hq/actions/*.
const BUMP_LIMIT = `
  INSERT INTO hq_login_limits AS l (key, count, window_start)
  VALUES ($1, 1, now())
  ON CONFLICT (key) DO UPDATE SET
    count = CASE WHEN l.window_start < now() - interval '15 minutes' THEN 1 ELSE l.count + 1 END,
    window_start = CASE WHEN l.window_start < now() - interval '15 minutes'
      THEN now() ELSE l.window_start END
  RETURNING count`;

const ADD_FINALIST = `
  INSERT INTO hq_finalists (project_id, position)
  SELECT $1::uuid, COALESCE((SELECT max(position) FROM hq_finalists), 0) + 1
  WHERE (SELECT count(*) FROM hq_finalists) < $2::int
    AND ($3::boolean OR NOT EXISTS (
      SELECT 1 FROM hq_submission_gates g
      WHERE NOT EXISTS (
        SELECT 1 FROM hq_project_gates pg
        WHERE pg.project_id = $4::uuid AND pg.gate_id = g.id)))
  ON CONFLICT (project_id) DO NOTHING
  RETURNING position`;

const SET_WINNER = `
  UPDATE hq_awards SET winner_project_id = $1::uuid
  WHERE id = $2::uuid
    AND ($3::boolean OR EXISTS (SELECT 1 FROM hq_finalists WHERE project_id = $4::uuid))
  RETURNING id`;

const ADD_SCORE = `
  INSERT INTO hq_scores (judge_id, project_id, score, note)
  VALUES ($1,$2,$3,$4)
  ON CONFLICT (judge_id, project_id) DO UPDATE
  SET score = EXCLUDED.score, note = EXCLUDED.note`;

const LOAD_USER = `
  SELECT u.id, u.username, s.last_seen_at
  FROM hq_sessions s JOIN hq_users u ON u.id = s.user_id
  WHERE s.id = $1 AND s.user_id = $2 AND s.expires_at > now()
    AND s.last_seen_at > now() - interval '24 hours'`;

describe("schema migration", () => {
  it("applies to an empty database and is idempotent", async () => {
    const db = connect();
    await migrate(db);
    await expect(migrate(db)).resolves.not.toThrow();
    const [{ idx }] = await db.query(`SELECT to_regclass('hq_finalists_position_key') AS idx`);
    expect(idx).toBeTruthy();
    const [otherRole] = await db.query(
      `SELECT filter_label, is_judge, sort FROM hq_people_roles WHERE label = 'Other'`,
    );
    expect(otherRole).toEqual({ filter_label: "Other", is_judge: false, sort: 4 });
    const [rejectedStage] = await db.query(
      `SELECT drop_color, sort FROM hq_partner_stages WHERE slug = 'rejected'`,
    );
    expect(rejectedStage).toEqual({ drop_color: "#c03b2d", sort: 4 });
  });
});

describe("upgrading a database created before the integrity constraints", () => {
  let db: Db;
  let projects: Record<string, string>;

  beforeAll(async () => {
    db = connect();
    // The pre-upgrade shape: no unique position, scores keyed by judge_name
    // and scoped to projects, award winners pointing at any project.
    const legacy = statements(SCHEMA).filter(
      (s) =>
        !/hq_login_limits|hq_sessions|hq_login_attempts_created_idx|hq_projects_partner_idx/.test(s) &&
        !/CREATE TABLE IF NOT EXISTS hq_(finalists|awards|scores)\b/.test(s),
    );
    for (const statement of legacy) await db.query(statement);
    await db.query(`CREATE TABLE hq_finalists (
      project_id uuid PRIMARY KEY REFERENCES hq_projects (id) ON DELETE CASCADE,
      position int NOT NULL)`);
    await db.query(`CREATE TABLE hq_awards (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
      sponsor text NOT NULL DEFAULT '', amount int NOT NULL DEFAULT 0,
      winner_project_id uuid REFERENCES hq_projects (id) ON DELETE SET NULL,
      sort int NOT NULL DEFAULT 0)`);
    await db.query(`CREATE TABLE hq_scores (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), judge_name text NOT NULL,
      project_id uuid NOT NULL REFERENCES hq_projects (id) ON DELETE CASCADE,
      score int NOT NULL CHECK (score BETWEEN 1 AND 10), note text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now())`);
    await seed(db);
    projects = await byName(db, "hq_projects");

    // Data with every pathology the upgrade has to survive.
    await db.query(
      `INSERT INTO hq_finalists (project_id, position) VALUES ($1,1),($2,1),($3,5)`,
      [projects.P1, projects.P2, projects.P3],
    );
    await db.query(
      `INSERT INTO hq_awards (name, winner_project_id, sort) VALUES ('Grand',$1,0),('Side',$2,1)`,
      [projects.P1, projects.P4],
    );
    await db.query(
      `INSERT INTO hq_scores (judge_name, project_id, score, created_at) VALUES
        ('Judge One',$1,8, now() - interval '2 hours'),
        ('Judge One',$1,9, now() - interval '1 hour'),
        ('Judge Two',$2,7, now()),
        ('Ghost Judge',$1,5, now()),
        ('Judge One',$3,6, now())`,
      [projects.P1, projects.P2, projects.P4],
    );
    await migrate(db);
  });

  it("renumbers duplicate finalist positions instead of failing", async () => {
    const rows = await db.query(`SELECT position FROM hq_finalists ORDER BY position`);
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3]);
  });

  it("keeps finalist award winners and clears the rest", async () => {
    const rows = await db.query(`SELECT name, winner_project_id FROM hq_awards ORDER BY sort`);
    expect(rows[0].winner_project_id).toBe(projects.P1);
    expect(rows[1].winner_project_id).toBeNull();
  });

  it("moves scores to judge ids, dropping orphans and duplicates", async () => {
    const rows = await db.query(
      `SELECT s.score, pe.name AS judge, pr.name AS project FROM hq_scores s
       JOIN hq_people pe ON pe.id = s.judge_id
       JOIN hq_projects pr ON pr.id = s.project_id ORDER BY pr.name`,
    );
    expect(rows).toEqual([
      { score: 9, judge: "Judge One", project: "P1" }, // newest of the pair
      { score: 7, judge: "Judge Two", project: "P2" },
    ]);
    const columns = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='hq_scores'`,
    );
    expect(columns.map((c) => c.column_name)).not.toContain("judge_name");
  });

  it("cascades a finalist removal to its scores and award win", async () => {
    await db.query(`DELETE FROM hq_finalists WHERE project_id = $1`, [projects.P1]);
    const scores = await db.query(`SELECT 1 FROM hq_scores WHERE project_id = $1`, [projects.P1]);
    const [grand] = await db.query(`SELECT winner_project_id FROM hq_awards WHERE name='Grand'`);
    expect(scores).toHaveLength(0);
    expect(grand.winner_project_id).toBeNull();
  });

  it("is a no-op when run again", async () => {
    await expect(migrate(db)).resolves.not.toThrow();
  });
});

describe("demo-day invariants", () => {
  let db: Db;
  let projects: Record<string, string>;
  let people: Record<string, string>;

  beforeAll(async () => {
    db = connect();
    await migrate(db);
    await seed(db);
    projects = await byName(db, "hq_projects");
    people = await byName(db, "hq_people");
    const gates = await db.query(`SELECT id FROM hq_submission_gates ORDER BY sort`);
    // P1 passes every gate; P2 passes one.
    await db.query(
      `INSERT INTO hq_project_gates (project_id, gate_id) VALUES ($1,$2),($1,$3),($4,$2)`,
      [projects.P1, gates[0].id, gates[1].id, projects.P2],
    );
  });

  it("accepts a fully gated project when verified-only is on", async () => {
    const rows = await db.query(ADD_FINALIST, [projects.P1, 30, false, projects.P1]);
    expect(rows).toHaveLength(1);
  });

  it("rejects a partially gated project when verified-only is on", async () => {
    const rows = await db.query(ADD_FINALIST, [projects.P2, 30, false, projects.P2]);
    expect(rows).toHaveLength(0);
  });

  it("ignores a duplicate finalist", async () => {
    const rows = await db.query(ADD_FINALIST, [projects.P1, 30, true, projects.P1]);
    expect(rows).toHaveLength(0);
  });

  it("enforces the finalist cap in SQL", async () => {
    const rows = await db.query(ADD_FINALIST, [projects.P2, 1, true, projects.P2]);
    expect(rows).toHaveLength(0);
  });

  it("assigns unique sequential positions", async () => {
    await db.query(ADD_FINALIST, [projects.P2, 30, true, projects.P2]);
    const rows = await db.query(`SELECT position FROM hq_finalists ORDER BY position`);
    expect(rows.map((r) => r.position)).toEqual([1, 2]);
    await expect(
      db.query(`INSERT INTO hq_finalists (project_id, position) VALUES ($1, 1)`, [projects.P3]),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it("only lets a current finalist win an award", async () => {
    const [award] = await db.query(
      `INSERT INTO hq_awards (name, sponsor, amount, sort)
       SELECT $1::text, '', $2::int, COALESCE(max(sort), 0) + 1 FROM hq_awards RETURNING id`,
      ["Grand", 5000],
    );
    expect(await db.query(SET_WINNER, [projects.P1, award.id, false, projects.P1])).toHaveLength(1);
    expect(await db.query(SET_WINNER, [projects.P3, award.id, false, projects.P3])).toHaveLength(0);
    expect(await db.query(SET_WINNER, [null, award.id, true, null])).toHaveLength(1);
  });

  it("keeps one score per judge per finalist, replacing on re-score", async () => {
    await db.query(ADD_SCORE, [people["Judge One"], projects.P1, 7, "first"]);
    await db.query(ADD_SCORE, [people["Judge One"], projects.P1, 9, "second"]);
    const rows = await db.query(
      `SELECT score, note FROM hq_scores WHERE judge_id=$1 AND project_id=$2`,
      [people["Judge One"], projects.P1],
    );
    expect(rows).toEqual([{ score: 9, note: "second" }]);
  });

  it("refuses a score for a project that is not a finalist", async () => {
    await expect(
      db.query(ADD_SCORE, [people["Judge One"], projects.P3, 5, ""]),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("refuses a score outside 1..10", async () => {
    await expect(
      db.query(ADD_SCORE, [people["Judge Two"], projects.P1, 44, ""]),
    ).rejects.toThrow(/check|violates/i);
  });
});

describe("login limiter", () => {
  let db: Db;

  beforeAll(async () => {
    db = connect();
    await migrate(db);
  });

  it("counts within a window and never grows the table", async () => {
    const counts = [];
    for (let i = 0; i < 3; i++) {
      const [row] = await db.query(BUMP_LIMIT, ["ip:1.2.3.4"]);
      counts.push(row.count);
    }
    expect(counts).toEqual([1, 2, 3]);
    const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM hq_login_limits`);
    expect(n).toBe(1);
  });

  it("resets once the window has passed", async () => {
    await db.query(
      `UPDATE hq_login_limits SET window_start = now() - interval '20 minutes' WHERE key='ip:1.2.3.4'`,
    );
    const [row] = await db.query(BUMP_LIMIT, ["ip:1.2.3.4"]);
    expect(row.count).toBe(1);
  });

  it("credits a successful login back so the window counts failures only", async () => {
    await db.query(`UPDATE hq_login_limits SET count = greatest(count - 1, 0) WHERE key = $1`, [
      "ip:1.2.3.4",
    ]);
    const [row] = await db.query(`SELECT count FROM hq_login_limits WHERE key='ip:1.2.3.4'`);
    expect(row.count).toBe(0);
  });
});

describe("session lifetime", () => {
  let db: Db;
  let userId: string;
  let sessionId: string;

  beforeAll(async () => {
    db = connect();
    await migrate(db);
    await seed(db);
    const [user] = await db.query(`SELECT id FROM hq_users`);
    userId = String(user.id);
    const [session] = await db.query(
      `INSERT INTO hq_sessions (user_id, expires_at)
       VALUES ($1, now() + interval '7 days') RETURNING id`,
      [userId],
    );
    sessionId = String(session.id);
  });

  it("loads the user for a live session", async () => {
    expect(await db.query(LOAD_USER, [sessionId, userId])).toHaveLength(1);
  });

  it("rejects a session idle for more than a day", async () => {
    await db.query(`UPDATE hq_sessions SET last_seen_at = now() - interval '25 hours' WHERE id=$1`, [
      sessionId,
    ]);
    expect(await db.query(LOAD_USER, [sessionId, userId])).toHaveLength(0);
  });

  it("rejects a session past its absolute expiry", async () => {
    await db.query(
      `UPDATE hq_sessions SET last_seen_at = now(), expires_at = now() - interval '1 minute' WHERE id=$1`,
      [sessionId],
    );
    expect(await db.query(LOAD_USER, [sessionId, userId])).toHaveLength(0);
  });

  it("rejects a deleted session, so logout revokes a copied token", async () => {
    await db.query(`UPDATE hq_sessions SET expires_at = now() + interval '1 day' WHERE id=$1`, [
      sessionId,
    ]);
    expect(await db.query(LOAD_USER, [sessionId, userId])).toHaveLength(1);
    await db.query(`DELETE FROM hq_sessions WHERE id=$1`, [sessionId]);
    expect(await db.query(LOAD_USER, [sessionId, userId])).toHaveLength(0);
  });
});
