// The whole migration, the way scripts/hq/migrate.ts runs it: schema.sql,
// applyUpgrades(), member-auth-schema.sql, builder-schema.sql, one statement
// per call through the same splitter. Twice on a fresh PGlite, so every
// statement is proven idempotent, and once more over a populated database
// that started life before hackathon scoping, so the additive identity
// statements are proven safe for the rows a live database already holds.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { CLEAR_TABLES, KEEP_TABLES } from "@/scripts/hq/reset-statements";
import { applyMigrations, createMigratedDatabase, readSqlFile, splitStatements } from "./helpers/db";

type Row = Record<string, unknown>;

/** scripts/hq/schema.sql as it was before hackathon scoping: the oldest live shape. */
const PRE_HACKATHON_SCHEMA = readFileSync(join(process.cwd(), "tests/hq/fixtures/schema-pre-hackathon.sql"), "utf8");
const SQL_FILES = ["schema.sql", "member-auth-schema.sql", "builder-schema.sql"] as const;

async function run(pg: PGlite, text: string, params: unknown[] = []): Promise<Row[]> {
  return (await pg.query(text, params)).rows as Row[];
}

async function hqTables(pg: PGlite): Promise<string[]> {
  const rows = await run(
    pg,
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name LIKE 'hq\\_%' ORDER BY table_name`,
  );
  return rows.map((r) => String(r.table_name));
}

async function column(pg: PGlite, table: string, name: string): Promise<Row | undefined> {
  const [row] = await run(
    pg,
    `SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, name],
  );
  return row;
}

async function exists(pg: PGlite, relation: string): Promise<boolean> {
  const [{ oid }] = await run(pg, `SELECT to_regclass($1) AS oid`, [relation]);
  return oid !== null;
}

/** Every hq_ column and index, so two runs can be compared for drift. */
async function shape(pg: PGlite): Promise<Row[]> {
  const columns = await run(
    pg,
    `SELECT table_name, column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name LIKE 'hq\\_%'
     ORDER BY table_name, column_name`,
  );
  const indexes = await run(
    pg,
    `SELECT tablename, indexname, indexdef FROM pg_indexes
     WHERE schemaname = current_schema() AND tablename LIKE 'hq\\_%'
     ORDER BY tablename, indexname`,
  );
  return [...columns, ...indexes];
}

/** The identity columns and tables this phase adds, checked the way an operator would. */
async function expectIdentitySchema(pg: PGlite) {
  expect(await exists(pg, "hq_crm_persons")).toBe(true);
  expect(await column(pg, "hq_builder_profiles", "email")).toEqual({ data_type: "text", is_nullable: "YES" });
  expect(await column(pg, "hq_builder_profiles", "contact_email")).toEqual({ data_type: "text", is_nullable: "YES" });
  expect(await column(pg, "hq_people", "person_id")).toEqual({ data_type: "uuid", is_nullable: "YES" });
  expect(await column(pg, "hq_project_members", "person_id")).toEqual({ data_type: "uuid", is_nullable: "YES" });
  expect(await column(pg, "hq_crm_persons", "builder_user_id")).toEqual({ data_type: "text", is_nullable: "YES" });
  for (const index of ["hq_people_person_idx", "hq_crm_persons_username_idx", "hq_crm_persons_builder_user_id_key"]) {
    expect(await exists(pg, index), index).toBe(true);
  }
}

describe("the migration files", () => {
  it("contain nothing the one-statement-per-call runner cannot send", () => {
    for (const file of SQL_FILES) {
      for (const statement of splitStatements(readSqlFile(file))) {
        // Splitting already consumed every terminator at a line end. Outside
        // a `--` comment, a `;` that survives is a second statement on the
        // same line or a terminator inside a literal, and `$$` is a procedural
        // body: each of them breaks under the Neon HTTP driver.
        const code = statement.replace(/--[^\n]*/g, "");
        expect(code, `${file}: ${statement.slice(0, 60)}`).not.toMatch(/;/);
        expect(code, `${file}: ${statement.slice(0, 60)}`).not.toMatch(/\$\$/);
      }
    }
  });
});

describe("a fresh database", () => {
  it("takes the whole migration twice without drift", async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      const first = await shape(pg);
      await applyMigrations(pg);
      expect(await shape(pg)).toEqual(first);
      await expectIdentitySchema(pg);
      // Nullable email means an account without one can exist at all.
      await run(pg, `INSERT INTO hq_builder_profiles (id, email, name) VALUES ('telegram-only', NULL, 'No Email')`);
      expect(await run(pg, `SELECT email, contact_email FROM hq_builder_profiles`)).toEqual([{ email: null, contact_email: null }]);
    } finally {
      await pg.close();
    }
  });

  it("has every hq_ table classified in the reset manifest, and nothing classified that does not exist", async () => {
    const pg = await createMigratedDatabase();
    try {
      const listed = new Set<string>([...CLEAR_TABLES, ...KEEP_TABLES, "hq_luma_sync"]);
      const tables = await hqTables(pg);
      expect(tables.filter((t) => !listed.has(t))).toEqual([]);
      expect([...listed].filter((t) => !tables.includes(t))).toEqual([]);
    } finally {
      await pg.close();
    }
  });
});

describe("a populated database from before hackathon scoping", () => {
  async function apply(pg: PGlite, text: string) {
    for (const statement of splitStatements(text)) await run(pg, statement);
  }

  /** Enough of the old world to prove nothing about logins or People is lost. */
  async function seedOperators(pg: PGlite) {
    await run(
      pg,
      `INSERT INTO hq_users (username, display_name, password_hash, password_version, must_change_password)
       VALUES ('cap', 'Cap', '$2b$10$fictionalhash.one', 3, false), ('lead', 'Lead', '$2b$10$fictionalhash.two', 1, true)`,
    );
    await run(pg, `INSERT INTO hq_people_roles (label, filter_label, color, bg, is_judge, sort) VALUES ('Judge','Judges','indigo','fill-3',true,0)`);
    await run(pg, `INSERT INTO hq_people (name, role_id) SELECT 'Judge One', id FROM hq_people_roles`);
  }

  /** Public accounts and their People cards as the store wrote them before this phase. */
  async function seedAccounts(pg: PGlite) {
    await run(
      pg,
      `INSERT INTO hq_builder_profiles (id, email, name)
       VALUES ('acct-email', 'builder@example.test', 'Email Builder'), ('acct-second', 'second@example.test', 'Second Builder')`,
    );
    // The Builder role already exists: applyUpgrades() seeds it.
    await run(
      pg,
      `INSERT INTO hq_people (hackathon_id, builder_user_id, name, role_id, contact)
       SELECT h.id, p.id, p.name, r.id, p.email FROM hq_builder_profiles p, hq_hackathons h, hq_people_roles r
       WHERE r.label = 'Builder'`,
    );
    await run(pg, `INSERT INTO hq_builder_enrollments (user_id, hackathon_id) SELECT p.id, h.id FROM hq_builder_profiles p, hq_hackathons h`);
  }

  it("keeps operator logins and People links, and gives every linked People card its person", async () => {
    const pg = new PGlite();
    try {
      await apply(pg, PRE_HACKATHON_SCHEMA);
      await seedOperators(pg);
      // First pass: exactly what a live database went through up to now.
      await applyMigrations(pg);
      await seedAccounts(pg);

      const users = await run(pg, `SELECT id, username, password_hash, password_version, must_change_password FROM hq_users ORDER BY username`);
      const people = await run(pg, `SELECT id, name, builder_user_id, contact FROM hq_people ORDER BY name`);
      expect(users).toHaveLength(2);
      expect(people).toHaveLength(3);
      expect(await run(pg, `SELECT count(*)::int AS n FROM hq_people WHERE person_id IS NOT NULL`)).toEqual([{ n: 0 }]);

      // Second pass, over populated tables.
      await applyMigrations(pg);
      await expectIdentitySchema(pg);
      expect(await run(pg, `SELECT id, username, password_hash, password_version, must_change_password FROM hq_users ORDER BY username`)).toEqual(users);
      expect(await run(pg, `SELECT id, name, builder_user_id, contact FROM hq_people ORDER BY name`)).toEqual(people);

      // One person per account, carrying the account's name, linked both ways.
      expect(
        await run(pg, `SELECT display_name, builder_user_id, normalized_colosseum_username FROM hq_crm_persons ORDER BY builder_user_id`),
      ).toEqual([
        { display_name: "Email Builder", builder_user_id: "acct-email", normalized_colosseum_username: null },
        { display_name: "Second Builder", builder_user_id: "acct-second", normalized_colosseum_username: null },
      ]);
      expect(
        await run(
          pg,
          `SELECT p.name, p.person_id IS NOT NULL AS linked, c.builder_user_id = p.builder_user_id AS same_account
           FROM hq_people p LEFT JOIN hq_crm_persons c ON c.id = p.person_id ORDER BY p.name`,
        ),
      ).toEqual([
        { name: "Email Builder", linked: true, same_account: true },
        { name: "Judge One", linked: false, same_account: null },
        { name: "Second Builder", linked: true, same_account: true },
      ]);

      // Third pass: the backfill matches nothing and creates nothing.
      await applyMigrations(pg);
      expect(await run(pg, `SELECT count(*)::int AS n FROM hq_crm_persons`)).toEqual([{ n: 2 }]);
      expect(await run(pg, `SELECT id, name, builder_user_id, contact FROM hq_people ORDER BY name`)).toEqual(people);
    } finally {
      await pg.close();
    }
  }, 30_000);
});
