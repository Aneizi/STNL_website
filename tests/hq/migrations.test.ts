import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { loadMigrations, runMigrations, type Migration, type MigrationConnection } from "@/scripts/hq/migrations";
import { applyLegacyMigrations, pgliteMigrationConnection } from "./helpers/db";

function sqlMigration(id: string, sql: string): Migration {
  return {
    id,
    checksum: createHash("sha256").update(sql).digest("hex"),
    apply: async (db) => { await db.execute(sql); },
  };
}

async function history(pg: PGlite) {
  return (await pg.query("SELECT id, checksum FROM hq_migrations ORDER BY id")).rows;
}

async function schemaShape(pg: PGlite) {
  return (await pg.query(`SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema=current_schema() AND table_name LIKE 'hq_%' AND table_name <> 'hq_migrations'
    ORDER BY table_name,column_name`)).rows;
}

describe("versioned HQ migrations", () => {
  // Two cold Postgres instances and two complete schemas exceed Vitest's
  // default five seconds on the shared GitHub runner.
  it("installs the complete legacy schema and records the bootstrap exactly once", async () => {
    const pg = new PGlite();
    const legacy = new PGlite();
    try {
      const migrations = loadMigrations();
      expect(await runMigrations(pgliteMigrationConnection(pg), migrations)).toEqual(["0001-legacy-bootstrap"]);
      await applyLegacyMigrations(legacy);
      expect(await schemaShape(pg)).toEqual(await schemaShape(legacy));
      const { rows } = await pg.query(`SELECT to_regclass('hq_reporting_entries') IS NOT NULL AS reporting,
        to_regclass('hq_colosseum_updates') IS NOT NULL AS updates,
        to_regclass('hq_projects_hackathon_idx') IS NOT NULL AS scoped_index`);
      expect(rows).toEqual([{ reporting: true, updates: true, scoped_index: true }]);
      expect(await history(pg)).toEqual(migrations.map(({ id, checksum }) => ({ id, checksum })));

      await pg.query("UPDATE hq_partner_stages SET label='Operator custom label' WHERE slug='rejected'");
      expect(await runMigrations(pgliteMigrationConnection(pg), migrations)).toEqual([]);
      expect((await pg.query("SELECT label FROM hq_partner_stages WHERE slug='rejected'")).rows)
        .toEqual([{ label: "Operator custom label" }]);
    } finally { await Promise.all([pg.close(), legacy.close()]); }
  }, 30_000);

  it("adopts an existing unversioned database without losing accounts or project data", async () => {
    const pg = new PGlite();
    try {
      await applyLegacyMigrations(pg);
      await pg.exec(`INSERT INTO hq_users (username,display_name,password_hash) VALUES ('operator','Operator','existing-hash');
        INSERT INTO hq_hackathons (id,slug,name,start_date,end_date) VALUES (93,'existing','Existing edition','2026-09-14','2026-10-12');
        INSERT INTO hq_project_statuses (slug,label,color) VALUES ('green','Green','green');
        INSERT INTO hq_project_forecasts (slug,label,color) VALUES ('likely','Likely','green');
        INSERT INTO hq_projects (hackathon_id,name,status_id,forecast_id,last_check_in)
          SELECT 93,'Existing team',s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f;
        INSERT INTO hq_project_notes (project_id,body) SELECT id,'Keep this note' FROM hq_projects;`);
      const before = (await pg.query("SELECT id, name, hackathon_id FROM hq_projects")).rows;

      await runMigrations(pgliteMigrationConnection(pg), loadMigrations());
      expect((await pg.query("SELECT id, name, hackathon_id FROM hq_projects")).rows).toEqual(before);
      expect((await pg.query("SELECT body FROM hq_project_notes")).rows).toEqual([{ body: "Keep this note" }]);
      expect((await pg.query("SELECT password_hash FROM hq_users")).rows).toEqual([{ password_hash: "existing-hash" }]);
      expect(await history(pg)).toHaveLength(1);
    } finally { await pg.close(); }
  });

  it("preserves operator-edited classifiers on the first adoption of an unversioned database", async () => {
    const pg = new PGlite();
    try {
      await applyLegacyMigrations(pg);
      await pg.exec(`UPDATE hq_people_roles SET filter_label='Guest judges',color='purple',bg='purple-fill',is_judge=true,sort=81
          WHERE label='Other';
        UPDATE hq_partner_stages SET label='Closed conversation',drop_color='#123456',sort=82 WHERE slug='rejected';
        INSERT INTO hq_partner_stages (slug,label,drop_color,sort) VALUES ('call','Follow-up scheduled','#654321',83);
        INSERT INTO hq_exchange_items (slug,label,sort) VALUES ('mailing','Community announcement agreed',84);`);
      const classifications = async () => ({
        roles: (await pg.query("SELECT * FROM hq_people_roles ORDER BY id")).rows,
        stages: (await pg.query("SELECT * FROM hq_partner_stages ORDER BY id")).rows,
        exchange: (await pg.query("SELECT * FROM hq_exchange_items ORDER BY id")).rows,
      });
      const before = await classifications();

      expect(await runMigrations(pgliteMigrationConnection(pg), loadMigrations())).toEqual(["0001-legacy-bootstrap"]);
      expect(await classifications()).toEqual(before);
      expect(await history(pg)).toHaveLength(1);
    } finally { await pg.close(); }
  });

  it("preserves checked snapshots including intentional empty fields, while backfilling legacy unchecked rows", async () => {
    const pg = new PGlite();
    try {
      await applyLegacyMigrations(pg);
      await pg.exec(`INSERT INTO hq_hackathons (id,slug,name,start_date,end_date) VALUES (93,'existing','Existing edition','2026-09-14','2026-10-12');
        INSERT INTO hq_project_statuses (slug,label,color) VALUES ('green','Green','green');
        INSERT INTO hq_project_forecasts (slug,label,color) VALUES ('likely','Likely','green');
        INSERT INTO hq_builder_profiles (id,email,name) VALUES ('owner','owner@example.test','Owner');`);
      for (const [index, status] of ["ok", "error", "never"].entries()) {
        const [{ id }] = (await pg.query<{ id: string }>(`INSERT INTO hq_projects (hackathon_id,name,status_id,forecast_id,last_check_in)
          SELECT 93,$1,s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f RETURNING id`, [status])).rows;
        // Current parsing deliberately normalizes whitespace-only strings,
        // empty handles and tracks to NULL/[], despite retaining the raw body.
        const raw = { project: {
          category: status === "never" ? "Payments" : "   ",
          twitterHandle: status === "never" ? "legacyteam" : "@@",
          tracks: status === "never" ? ["Consumer"] : ["   "],
          website: "https://example.test", repoLink: "https://example.test/repo",
          presentationLink: "https://example.test/slides", technicalDemoLink: "https://example.test/demo",
          pitchVideoLink: "https://example.test/pitch", demoVideoLink: "https://example.test/video",
          image: { url: "https://example.test/image" },
          hackathon: { id: 6, slug: "frontier", name: "Frontier" },
        } };
        await pg.query(`INSERT INTO hq_project_onboarding
          (project_id,hackathon_id,external_id,project_url,slug,raw,owner_user_id,lead_username,source_status,source_checked_at)
          VALUES ($1,93,$2,'https://colosseum.com/arena/projects/explore/test',$3,$4::jsonb,'owner','owner',$3,
            CASE WHEN $3='never' THEN NULL ELSE '2026-09-14T12:00:00Z'::timestamptz END)`, [id, index + 1, status, JSON.stringify(raw)]);
      }
      const checkedSnapshots = async () => (await pg.query("SELECT * FROM hq_project_onboarding WHERE slug IN ('ok','error') ORDER BY slug")).rows;
      const before = await checkedSnapshots();

      await runMigrations(pgliteMigrationConnection(pg), loadMigrations());
      expect(await checkedSnapshots()).toEqual(before);
      expect((await pg.query(`SELECT category,twitter_handle,tracks,website,repo_link,presentation_link,
        technical_demo_link,pitch_video_link,demo_video_link,image_url,external_hackathon_id,external_hackathon_slug,
        external_hackathon_name,source_status,source_checked_at=created_at AS checked_at_import,submission_status
        FROM hq_project_onboarding WHERE slug='never'`)).rows).toEqual([{
        category: "Payments", twitter_handle: "legacyteam", tracks: ["Consumer"],
        website: "https://example.test", repo_link: "https://example.test/repo", presentation_link: "https://example.test/slides",
        technical_demo_link: "https://example.test/demo", pitch_video_link: "https://example.test/pitch",
        demo_video_link: "https://example.test/video", image_url: "https://example.test/image",
        external_hackathon_id: 6, external_hackathon_slug: "frontier", external_hackathon_name: "Frontier",
        source_status: "ok", checked_at_import: true, submission_status: "not_checked",
      }]);
    } finally { await pg.close(); }
  });

  it("still upgrades populated pre-hackathon databases through the recorded bootstrap", async () => {
    const pg = new PGlite();
    try {
      await pg.exec(readFileSync(join(process.cwd(), "tests/hq/fixtures/schema-pre-hackathon.sql"), "utf8"));
      await pg.exec(`INSERT INTO hq_people_roles (label,filter_label,color,bg) VALUES ('Legacy','Legacy','green','green');
        INSERT INTO hq_people (name,role_id,contact) SELECT 'Existing person',id,'existing@example.test' FROM hq_people_roles;
        INSERT INTO hq_partner_stages (slug,label,drop_color,sort) VALUES ('call','Called','#ee5b23',2);
        INSERT INTO hq_exchange_items (slug,label,sort) VALUES ('mailing','Mailing sent to their list',0);`);
      const before = (await pg.query("SELECT id, name, contact FROM hq_people")).rows;
      const [oldStage] = (await pg.query<Record<string, unknown>>("SELECT * FROM hq_partner_stages WHERE slug='call'")).rows;
      const [oldExchange] = (await pg.query<Record<string, unknown>>("SELECT * FROM hq_exchange_items WHERE slug='mailing'")).rows;

      await runMigrations(pgliteMigrationConnection(pg), loadMigrations());
      expect((await pg.query("SELECT id, name, contact FROM hq_people")).rows).toEqual(before);
      expect((await pg.query("SELECT hackathon_id FROM hq_people")).rows).toEqual([{ hackathon_id: 6 }]);
      expect((await pg.query("SELECT to_regclass('hq_people_hackathon_idx') IS NOT NULL AS present")).rows).toEqual([{ present: true }]);
      expect((await pg.query("SELECT * FROM hq_partner_stages WHERE slug='call'")).rows)
        .toEqual([{ ...oldStage, label: "Replied" }]);
      expect((await pg.query("SELECT * FROM hq_exchange_items WHERE slug='mailing'")).rows)
        .toEqual([{ ...oldExchange, label: "Communicated with community members" }]);
      expect((await pg.query("SELECT filter_label, is_judge, sort FROM hq_people_roles WHERE label='Other'")).rows)
        .toEqual([{ filter_label: "Other", is_judge: false, sort: 4 }]);
      expect((await pg.query("SELECT label, drop_color, sort FROM hq_partner_stages WHERE slug='rejected'")).rows)
        .toEqual([{ label: "Rejected", drop_color: "#c03b2d", sort: 4 }]);
      expect(await history(pg)).toHaveLength(1);
    } finally { await pg.close(); }
  });

  it("executes whole SQL files with quoted semicolons and procedural bodies", async () => {
    const pg = new PGlite();
    try {
      const migration = sqlMigration("0001-quoted-sql", `CREATE TABLE migration_example (value text);
        INSERT INTO migration_example VALUES ('first; second');
        DO $$ BEGIN UPDATE migration_example SET value = value || '; third'; END $$;`);
      await runMigrations(pgliteMigrationConnection(pg), [migration]);
      expect((await pg.query("SELECT value FROM migration_example")).rows).toEqual([{ value: "first; second; third" }]);
    } finally { await pg.close(); }
  });

  it("rejects changed applied checksums before running a new migration", async () => {
    const pg = new PGlite();
    try {
      const db = pgliteMigrationConnection(pg);
      const first = sqlMigration("0001-first", "CREATE TABLE original (value text)");
      await runMigrations(db, [first]);
      const changed = sqlMigration(first.id, "CREATE TABLE changed (value text)");
      const next = sqlMigration("0002-next", "CREATE TABLE should_not_exist (value text)");
      await expect(runMigrations(db, [changed, next])).rejects.toThrow("Checksum mismatch for 0001-first");
      expect((await pg.query("SELECT to_regclass('should_not_exist') AS relation")).rows).toEqual([{ relation: null }]);
      expect(await history(pg)).toEqual([{ id: first.id, checksum: first.checksum }]);
    } finally { await pg.close(); }
  });

  it("rejects missing or inserted historical migrations before making changes", async () => {
    const pg = new PGlite();
    try {
      const db = pgliteMigrationConnection(pg);
      const first = sqlMigration("0001-first", "SELECT 1");
      const third = sqlMigration("0003-third", "SELECT 3");
      await runMigrations(db, [first, third]);
      await expect(runMigrations(db, [first])).rejects.toThrow("Migration history differs at 0003-third");
      await expect(runMigrations(db, [first, sqlMigration("0002-second", "SELECT 2"), third]))
        .rejects.toThrow("Migration history differs at 0003-third");
      expect(await history(pg)).toHaveLength(2);
    } finally { await pg.close(); }
  });

  it("rolls back failed DDL and data changes with the unapplied ledger entry, then allows a retry", async () => {
    const pg = new PGlite();
    try {
      const db = pgliteMigrationConnection(pg);
      const first = sqlMigration("0001-first", "CREATE TABLE kept (value text); INSERT INTO kept VALUES ('original');");
      const failing = sqlMigration("0002-second", `CREATE TABLE partial (value text);
        UPDATE kept SET value='changed'; SELECT * FROM missing_migration_table;`);
      await expect(runMigrations(db, [first, failing])).rejects.toThrow("missing_migration_table");
      expect((await pg.query("SELECT value FROM kept")).rows).toEqual([{ value: "original" }]);
      expect((await pg.query("SELECT to_regclass('partial') AS relation")).rows).toEqual([{ relation: null }]);
      expect(await history(pg)).toEqual([{ id: first.id, checksum: first.checksum }]);
      expect((await pg.query("SELECT count(*)::int AS held FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()")).rows)
        .toEqual([{ held: 0 }]);

      const retry = sqlMigration(failing.id, "UPDATE kept SET value='completed'");
      expect(await runMigrations(db, [first, retry])).toEqual([retry.id]);
      expect((await pg.query("SELECT value FROM kept")).rows).toEqual([{ value: "completed" }]);
    } finally { await pg.close(); }
  });

  it("rolls back a migration when recording its ledger row fails", async () => {
    const pg = new PGlite();
    try {
      const base = pgliteMigrationConnection(pg);
      const db: MigrationConnection = {
        ...base,
        query: (text, values) => text.startsWith("INSERT INTO hq_migrations")
          ? Promise.reject(new Error("simulated ledger failure")) : base.query(text, values),
      };
      await expect(runMigrations(db, [sqlMigration("0001-first", "CREATE TABLE partial (value text)")]))
        .rejects.toThrow("simulated ledger failure");
      expect((await pg.query("SELECT to_regclass('partial') AS relation")).rows).toEqual([{ relation: null }]);
      expect(await history(pg)).toEqual([]);
    } finally { await pg.close(); }
  });

  it("waits for the other runner before reading history and applies a migration once", async () => {
    const pg = new PGlite();
    try {
      const base = pgliteMigrationConnection(pg);
      // PGlite has one physical session. Model two sessions' advisory lock
      // ownership while exercising the runner and transactional SQL unchanged.
      let queue = Promise.resolve();
      function session(): MigrationConnection {
        let release: (() => void) | undefined;
        return {
          ...base,
          async query(text, values) {
            if (text.startsWith("SELECT pg_advisory_lock(")) {
              const previous = queue;
              queue = new Promise<void>((resolve) => { release = resolve; });
              await previous;
              return { rows: [] };
            }
            if (text.startsWith("SELECT pg_advisory_unlock(")) {
              release?.();
              return { rows: [] };
            }
            return base.query(text, values);
          },
        };
      }
      const migration = sqlMigration("0001-first", "CREATE TABLE applied_once (value int); INSERT INTO applied_once VALUES (1);");
      const results = await Promise.all([runMigrations(session(), [migration]), runMigrations(session(), [migration])]);
      expect(results).toEqual([[migration.id], []]);
      expect((await pg.query("SELECT count(*)::int AS count FROM applied_once")).rows).toEqual([{ count: 1 }]);
      expect(await history(pg)).toHaveLength(1);
    } finally { await pg.close(); }
  });
});
