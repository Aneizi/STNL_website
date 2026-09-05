// HQ became hackathon-agnostic: every operational table carries a hackathon_id
// and each hackathon is a separate CRM. These run the real schema and upgrade
// path against a real Postgres (PGlite), so the backfill of a pre-hackathon
// database, the per-hackathon uniqueness rules, and the cascade that a
// hackathon delete triggers are exercised rather than assumed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FIRST_HACKATHON,
  HACKATHON_SCOPED_TABLES,
  applyUpgrades,
} from "@/scripts/hq/upgrades";

const SCHEMA = readFileSync(join(process.cwd(), "scripts/hq/schema.sql"), "utf8");
/** scripts/hq/schema.sql as it was before hackathon scoping — the live shape
 *  of every database the upgrade has to carry across. */
const PRE_HACKATHON_SCHEMA = readFileSync(
  join(process.cwd(), "tests/hq/fixtures/schema-pre-hackathon.sql"),
  "utf8",
);

function statements(text: string): string[] {
  return text
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

type Row = Record<string, unknown>;

let pg: PGlite;

async function run(text: string, params: unknown[] = []): Promise<Row[]> {
  return (await pg.query(text, params)).rows as Row[];
}

async function apply(schema: string) {
  for (const statement of statements(schema)) await run(statement);
}

/**
 * Exactly what scripts/hq/migrate.ts does to a live database: the current
 * schema.sql first (its IF NOT EXISTS statements skip the tables that exist),
 * then the in-code upgrades.
 */
async function migrate() {
  await apply(SCHEMA);
  await applyUpgrades({ query: (text) => run(text) });
}

async function upgrade() {
  await applyUpgrades({ query: (text) => run(text) });
}

async function count(table: string): Promise<number> {
  const [row] = await run(`SELECT count(*)::int AS n FROM ${table}`);
  return Number(row.n);
}

async function id(text: string, params: unknown[] = []): Promise<string> {
  const [row] = await run(text, params);
  return String(row.id);
}

/** Inserts a hackathon under an operator-chosen (Colosseum) id. */
async function addHackathon(
  hackathonId: number,
  slug: string,
  start: string,
  end: string,
): Promise<number> {
  const [row] = await run(
    `INSERT INTO hq_hackathons (id, slug, name, start_date, end_date)
     VALUES ($1, $2, $2, $3, $4) RETURNING id`,
    [hackathonId, slug, start, end],
  );
  return Number(row.id);
}

/** Shared classifiers, as the seed would leave them. */
async function seedClassifiers() {
  await run(`INSERT INTO hq_partner_channels (label, sort) VALUES ('Direct',0)`);
  await run(`INSERT INTO hq_event_types (label, supports_end_date, sort) VALUES ('Other',false,0)`);
  await run(`INSERT INTO hq_people_roles (label, filter_label, color, bg, is_judge, sort)
             VALUES ('Judge','Judges','indigo','fill-3',true,0)`);
  await run(`INSERT INTO hq_partner_stages (slug,label,drop_color,sort) VALUES ('lead','Lead','g',0)`);
  await run(`INSERT INTO hq_project_statuses (slug,label,color,counts_as_active,sort)
             VALUES ('green','Green','green',true,0)`);
  await run(`INSERT INTO hq_project_forecasts (slug,label,color,sort)
             VALUES ('committed','Committed','green',0)`);
  await run(`INSERT INTO hq_exchange_items (slug,label,sort) VALUES ('swag','Swag',0)`);
  await run(`INSERT INTO hq_users (username, display_name, password_hash) VALUES ('cap','Cap','x')`);
}

/**
 * A row in every table the old schema had, written the way the old app wrote
 * them (no hackathon anywhere), so the upgrade has something in each table to
 * carry across.
 */
async function seedPreHackathonData() {
  await seedClassifiers();
  const user = await id(`SELECT id FROM hq_users LIMIT 1`);
  await run(`INSERT INTO hq_submission_gates (label, sort) VALUES ('G1',0), ('G2',1)`);
  await run(`INSERT INTO hq_settings (key,value) VALUES ('timezone','"Europe/Amsterdam"'),
             ('finalist_cap','30')`);
  await run(`INSERT INTO hq_milestones (date,label) VALUES ('2026-09-28','Kickoff')`);
  const channel = await id(`SELECT id FROM hq_partner_channels LIMIT 1`);
  const stage = await id(`SELECT id FROM hq_partner_stages LIMIT 1`);
  const status = await id(`SELECT id FROM hq_project_statuses LIMIT 1`);
  const forecast = await id(`SELECT id FROM hq_project_forecasts LIMIT 1`);
  const role = await id(`SELECT id FROM hq_people_roles LIMIT 1`);
  const type = await id(`SELECT id FROM hq_event_types LIMIT 1`);
  const partner = await id(
    `INSERT INTO hq_partners (name, channel_id, stage_id) VALUES ('P',$1,$2) RETURNING id`,
    [channel, stage],
  );
  const p1 = await id(
    `INSERT INTO hq_projects (name, status_id, forecast_id, last_check_in, partner_id)
     VALUES ('Proj 1',$1,$2,current_date,$3) RETURNING id`,
    [status, forecast, partner],
  );
  const p2 = await id(
    `INSERT INTO hq_projects (name, status_id, forecast_id, last_check_in)
     VALUES ('Proj 2',$1,$2,current_date) RETURNING id`,
    [status, forecast],
  );
  const judge = await id(
    `INSERT INTO hq_people (name, role_id) VALUES ('Judge One',$1) RETURNING id`,
    [role],
  );
  await run(`INSERT INTO hq_events (name,date,type_id) VALUES ('Ev','2026-09-20',$1)`, [type]);
  await run(`INSERT INTO hq_finalists (project_id, position) VALUES ($1,1),($2,2)`, [p1, p2]);
  await run(`INSERT INTO hq_scores (judge_id, project_id, score) VALUES ($1,$2,8)`, [judge, p1]);
  await run(
    `INSERT INTO hq_awards (name, sponsor, amount, winner_project_id, sort)
     VALUES ('Best','S',100,$1,0)`,
    [p1],
  );
  await run(`INSERT INTO hq_activity (user_id, message) VALUES ($1,'did a thing')`, [user]);
  await run(`INSERT INTO hq_links (title, url) VALUES ('Form','https://x.y')`);
}

describe("upgrading a pre-hackathon database", () => {
  beforeEach(async () => {
    pg = new PGlite();
    await apply(PRE_HACKATHON_SCHEMA);
    await seedPreHackathonData();
    await migrate();
  });

  it("creates the first hackathon under Colosseum's id, with its name and dates", async () => {
    const rows = await run(
      `SELECT id, slug, name, start_date::text AS start_date, end_date::text AS end_date,
              archived_at
       FROM hq_hackathons`,
    );
    expect(rows).toEqual([
      {
        id: 6,
        slug: FIRST_HACKATHON.slug,
        name: "Colosseum World's Fair",
        start_date: "2026-09-14",
        end_date: "2026-10-12",
        archived_at: null,
      },
    ]);
  });

  it("files every existing row under it, with the column NOT NULL", async () => {
    const [hackathon] = await run(`SELECT id FROM hq_hackathons`);
    for (const table of HACKATHON_SCOPED_TABLES) {
      const rows = await run(`SELECT hackathon_id FROM ${table}`);
      expect(rows.length, `${table} should still have its rows`).toBeGreaterThan(0);
      expect(
        rows.every((r) => r.hackathon_id === hackathon.id),
        `${table} rows should belong to the first hackathon`,
      ).toBe(true);
      const [column] = await run(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_name = $1 AND column_name = 'hackathon_id'`,
        [table],
      );
      expect(column.is_nullable, `${table}.hackathon_id`).toBe("NO");
    }
  });

  it("keys settings and gate labels per hackathon", async () => {
    const [hackathon] = await run(`SELECT id FROM hq_hackathons`);
    const other = await addHackathon(7, "next", "2027-01-01", "2027-02-01");
    // Same key and label again, under another hackathon: allowed now.
    await run(`INSERT INTO hq_settings (hackathon_id, key, value) VALUES ($1,'timezone','"UTC"')`, [
      other,
    ]);
    await run(`INSERT INTO hq_submission_gates (hackathon_id, label, sort) VALUES ($1,'G1',0)`, [
      other,
    ]);
    // Within one hackathon they still collide.
    await expect(
      run(`INSERT INTO hq_settings (hackathon_id, key, value) VALUES ($1,'timezone','"UTC"')`, [
        hackathon.id,
      ]),
    ).rejects.toThrow(/unique|duplicate/i);
    await expect(
      run(`INSERT INTO hq_submission_gates (hackathon_id, label, sort) VALUES ($1,'G1',9)`, [
        hackathon.id,
      ]),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it("keeps finalist positions unique per hackathon rather than globally", async () => {
    const other = await addHackathon(7, "next", "2027-01-01", "2027-02-01");
    const status = await id(`SELECT id FROM hq_project_statuses LIMIT 1`);
    const forecast = await id(`SELECT id FROM hq_project_forecasts LIMIT 1`);
    const project = await id(
      `INSERT INTO hq_projects (hackathon_id, name, status_id, forecast_id, last_check_in)
       VALUES ($1,'Next proj',$2,$3,current_date) RETURNING id`,
      [other, status, forecast],
    );
    await expect(
      run(`INSERT INTO hq_finalists (project_id, hackathon_id, position) VALUES ($1,$2,1)`, [
        project,
        other,
      ]),
    ).resolves.toBeDefined();
    const [{ idx }] = await run(
      `SELECT to_regclass('hq_finalists_hackathon_id_position_key') AS idx`,
    );
    expect(idx).toBeTruthy();
    const [{ old }] = await run(`SELECT to_regclass('hq_finalists_position_key') AS old`);
    expect(old).toBeNull();
  });

  it("lets a gate be deleted, taking its ticks with it", async () => {
    const [gate] = await run(`SELECT id FROM hq_submission_gates WHERE label = 'G1'`);
    const [project] = await run(`SELECT id FROM hq_projects LIMIT 1`);
    await run(`INSERT INTO hq_project_gates (project_id, gate_id) VALUES ($1,$2)`, [
      project.id,
      gate.id,
    ]);
    await run(`DELETE FROM hq_submission_gates WHERE id = $1`, [gate.id]);
    expect(await count("hq_project_gates")).toBe(0);
  });

  it("is a no-op when run again", async () => {
    await expect(migrate()).resolves.not.toThrow();
    expect(await count("hq_hackathons")).toBe(1);
  });

  it("has every hackathon index in place", async () => {
    for (const table of ["hq_partners", "hq_projects", "hq_people", "hq_events", "hq_activity", "hq_links"]) {
      const [{ idx }] = await run(`SELECT to_regclass('${table}_hackathon_idx') AS idx`);
      expect(idx, `${table}_hackathon_idx`).toBeTruthy();
    }
  });

  it("resumes after a crash that left a column added but not yet NOT NULL", async () => {
    // Simulate a fresh pre-hackathon database whose upgrade died halfway.
    pg = new PGlite();
    await apply(PRE_HACKATHON_SCHEMA);
    await seedPreHackathonData();
    await run(`CREATE TABLE hq_hackathons (
      id int PRIMARY KEY, slug text NOT NULL UNIQUE,
      name text NOT NULL, start_date date NOT NULL, end_date date NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await run(`INSERT INTO hq_hackathons (id, slug, name, start_date, end_date)
               VALUES (6, 'colosseum-worlds-fair', $1, '2026-09-14', '2026-10-12')`, [
      FIRST_HACKATHON.name,
    ]);
    await run(`ALTER TABLE hq_partners ADD COLUMN hackathon_id int REFERENCES hq_hackathons (id)`);

    await migrate();

    const [column] = await run(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'hq_partners' AND column_name = 'hackathon_id'`,
    );
    expect(column.is_nullable).toBe("NO");
    expect(await count("hq_hackathons")).toBe(1);
    const [partner] = await run(`SELECT hackathon_id FROM hq_partners`);
    expect(partner.hackathon_id).toBe(6);
    // The table created by hand above lacked archived_at; the upgrade adds it.
    const [archived] = await run(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'hq_hackathons' AND column_name = 'archived_at'`,
    );
    expect(archived?.is_nullable).toBe("YES");
  });
});

describe("an empty pre-hackathon database", () => {
  it("gains the columns but no hackathon — the seed supplies that", async () => {
    pg = new PGlite();
    await apply(PRE_HACKATHON_SCHEMA);
    await migrate();
    expect(await count("hq_hackathons")).toBe(0);
    for (const table of HACKATHON_SCOPED_TABLES) {
      const [column] = await run(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_name = $1 AND column_name = 'hackathon_id'`,
        [table],
      );
      expect(column?.is_nullable, `${table}.hackathon_id`).toBe("NO");
    }
  });
});

describe("a fresh database", () => {
  beforeEach(async () => {
    pg = new PGlite();
    await apply(SCHEMA);
    await upgrade();
    await seedClassifiers();
  });

  it("gets no hackathon from the upgrade", async () => {
    expect(await count("hq_hackathons")).toBe(0);
  });

  it("refuses rows that belong to no hackathon", async () => {
    await expect(
      run(`INSERT INTO hq_links (title, url) VALUES ('Form','https://x.y')`),
    ).rejects.toThrow(/null/i);
  });

  it("deletes a hackathon's whole CRM with it and leaves the others alone", async () => {
    const a = await addHackathon(1, "a", "2026-01-01", "2026-02-01");
    const b = await addHackathon(2, "b", "2027-01-01", "2027-02-01");
    const status = await id(`SELECT id FROM hq_project_statuses LIMIT 1`);
    const forecast = await id(`SELECT id FROM hq_project_forecasts LIMIT 1`);
    for (const h of [a, b]) {
      const project = await id(
        `INSERT INTO hq_projects (hackathon_id, name, status_id, forecast_id, last_check_in)
         VALUES ($1,'Proj',$2,$3,current_date) RETURNING id`,
        [h, status, forecast],
      );
      await run(`INSERT INTO hq_project_notes (project_id, body) VALUES ($1,'note')`, [project]);
      await run(`INSERT INTO hq_finalists (project_id, hackathon_id, position) VALUES ($1,$2,1)`, [
        project,
        h,
      ]);
      await run(`INSERT INTO hq_settings (hackathon_id, key, value) VALUES ($1,'stale_days','7')`, [
        h,
      ]);
      await run(`INSERT INTO hq_activity (hackathon_id, message) VALUES ($1,'hi')`, [h]);
    }

    await run(`DELETE FROM hq_hackathons WHERE id = $1`, [a]);

    expect(await count("hq_projects")).toBe(1);
    expect(await count("hq_project_notes")).toBe(1);
    expect(await count("hq_finalists")).toBe(1);
    expect(await count("hq_settings")).toBe(1);
    expect(await count("hq_activity")).toBe(1);
    const [left] = await run(`SELECT hackathon_id FROM hq_projects`);
    expect(left.hackathon_id).toBe(b);
  });

  it("rejects a hackathon that ends before it starts", async () => {
    await expect(addHackathon(9, "x", "2026-02-01", "2026-01-01")).rejects.toThrow(/check/i);
  });

  it("takes the operator's id and refuses a second edition under the same one", async () => {
    await addHackathon(6, "wf", "2026-09-14", "2026-10-12");
    await expect(addHackathon(6, "again", "2027-01-01", "2027-02-01")).rejects.toThrow(
      /unique|duplicate/i,
    );
  });

  it("is never archived on its own: archived_at starts null whatever the dates", async () => {
    await addHackathon(1, "long-over", "2020-01-01", "2020-02-01");
    const [row] = await run(`SELECT archived_at FROM hq_hackathons WHERE id = 1`);
    expect(row.archived_at).toBeNull();
  });
});
