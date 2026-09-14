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
  // One Telegram account row per user, enforced below Better Auth's own checks.
  expect(await run(pg, `SELECT indexdef FROM pg_indexes WHERE indexname = 'hq_auth_account_telegram_user_idx'`)).toEqual([
    { indexdef: expect.stringMatching(/^CREATE UNIQUE INDEX hq_auth_account_telegram_user_idx ON public\.hq_auth_account USING btree \("userId"\) WHERE \("providerId" = 'telegram'::text\)$/) },
  ]);
  await run(pg, `INSERT INTO hq_auth_user (id, name, email) VALUES ('tg-user', 'Two Rows', 'two-rows@example.com')`);
  await run(pg, `INSERT INTO hq_auth_account (id, issuer, "accountId", "providerId", "userId") VALUES ('a1', 'https://oauth.telegram.org', 'sub-1', 'telegram', 'tg-user')`);
  await expect(run(pg, `INSERT INTO hq_auth_account (id, issuer, "accountId", "providerId", "userId") VALUES ('a2', 'https://oauth.telegram.org', 'sub-2', 'telegram', 'tg-user')`)).rejects.toThrow(/hq_auth_account_telegram_user_idx/);
  // The index is partial: another provider's row for the same user is not what it guards.
  await run(pg, `INSERT INTO hq_auth_account (id, issuer, "accountId", "providerId", "userId") VALUES ('a3', 'https://other.example', 'sub-3', 'other', 'tg-user')`);
  await run(pg, `DELETE FROM hq_auth_user WHERE id = 'tg-user'`);
  expect(await column(pg, "hq_builder_profiles", "email")).toEqual({ data_type: "text", is_nullable: "YES" });
  expect(await column(pg, "hq_builder_profiles", "contact_email")).toEqual({ data_type: "text", is_nullable: "YES" });
  expect(await column(pg, "hq_people", "person_id")).toEqual({ data_type: "uuid", is_nullable: "YES" });
  expect(await column(pg, "hq_project_members", "person_id")).toEqual({ data_type: "uuid", is_nullable: "YES" });
  expect(await column(pg, "hq_crm_persons", "builder_user_id")).toEqual({ data_type: "text", is_nullable: "YES" });
  for (const index of ["hq_people_person_idx", "hq_crm_persons_username_idx", "hq_crm_persons_builder_user_id_key"]) {
    expect(await exists(pg, index), index).toBe(true);
  }
  // Task T1.2: capability grants and the append-only audit trail.
  expect(await exists(pg, "hq_account_capabilities")).toBe(true);
  expect(await exists(pg, "hq_audit_events")).toBe(true);
  expect(await column(pg, "hq_account_capabilities", "granted_by_user_id")).toEqual({ data_type: "uuid", is_nullable: "YES" });
  expect(await column(pg, "hq_account_capabilities", "revoked_at")).toEqual({ data_type: "timestamp with time zone", is_nullable: "YES" });
  expect(await column(pg, "hq_audit_events", "id")).toEqual({ data_type: "bigint", is_nullable: "NO" });
  expect(await column(pg, "hq_audit_events", "project_id")).toEqual({ data_type: "uuid", is_nullable: "YES" });
  expect(await column(pg, "hq_audit_events", "metadata")).toEqual({ data_type: "jsonb", is_nullable: "NO" });
  for (const index of ["hq_account_capabilities_active_idx", "hq_account_capabilities_capability_idx", "hq_audit_events_subject_idx", "hq_audit_events_kind_idx"]) {
    expect(await exists(pg, index), index).toBe(true);
  }
  // Named, so a later capability is a DROP CONSTRAINT IF EXISTS plus ADD.
  expect(
    await run(pg, `SELECT conname FROM pg_constraint WHERE conrelid = 'hq_account_capabilities'::regclass AND contype = 'c' ORDER BY conname`),
  ).toEqual([{ conname: "hq_account_capabilities_capability_check" }]);
  // Task T2.3: bot-messaging consent, keyed on the account and cascading with it.
  expect(await exists(pg, "hq_telegram_bot_consent")).toBe(true);
  expect(await column(pg, "hq_telegram_bot_consent", "user_id")).toEqual({ data_type: "text", is_nullable: "NO" });
  expect(await column(pg, "hq_telegram_bot_consent", "telegram_user_id")).toEqual({ data_type: "bigint", is_nullable: "NO" });
  expect(await column(pg, "hq_telegram_bot_consent", "messaging_enabled")).toEqual({ data_type: "boolean", is_nullable: "NO" });
  expect(await column(pg, "hq_telegram_bot_consent", "consented_at")).toEqual({ data_type: "timestamp with time zone", is_nullable: "YES" });
  expect(await column(pg, "hq_telegram_bot_consent", "revoked_at")).toEqual({ data_type: "timestamp with time zone", is_nullable: "YES" });
  expect(await column(pg, "hq_telegram_bot_consent", "updated_at")).toEqual({ data_type: "timestamp with time zone", is_nullable: "NO" });
  expect(
    await run(pg, `SELECT confdeltype FROM pg_constraint WHERE conrelid = 'hq_telegram_bot_consent'::regclass AND contype = 'f'`),
  ).toEqual([{ confdeltype: "c" }]);
}

/** Task T4.1: Captain invitations, redemptions and assignments. */
async function expectCaptainSchema(pg: PGlite) {
  for (const table of ["hq_captain_invitations", "hq_captain_invitation_redemptions", "hq_captain_assignments"]) {
    expect(await exists(pg, table), table).toBe(true);
  }
  expect(await column(pg, "hq_captain_invitations", "token_hash")).toEqual({ data_type: "text", is_nullable: "NO" });
  expect(await column(pg, "hq_captain_invitations", "label")).toEqual({ data_type: "text", is_nullable: "YES" });
  expect(await column(pg, "hq_captain_invitations", "capability")).toEqual({ data_type: "text", is_nullable: "NO" });
  expect(await column(pg, "hq_captain_invitations", "max_redemptions")).toEqual({ data_type: "integer", is_nullable: "NO" });
  expect(await column(pg, "hq_captain_invitations", "expires_at")).toEqual({ data_type: "timestamp with time zone", is_nullable: "NO" });
  expect(await column(pg, "hq_captain_invitations", "created_by_user_id")).toEqual({ data_type: "uuid", is_nullable: "YES" });
  expect(await column(pg, "hq_captain_invitations", "created_at")).toEqual({ data_type: "timestamp with time zone", is_nullable: "NO" });
  expect(await column(pg, "hq_captain_invitations", "revoked_at")).toEqual({ data_type: "timestamp with time zone", is_nullable: "YES" });
  expect(await column(pg, "hq_captain_invitations", "revoked_by_user_id")).toEqual({ data_type: "uuid", is_nullable: "YES" });
  // Named, so a later change is a DROP CONSTRAINT IF EXISTS plus ADD, the same style as hq_account_capabilities.
  expect(
    await run(pg, `SELECT conname FROM pg_constraint WHERE conrelid = 'hq_captain_invitations'::regclass AND contype = 'c' ORDER BY conname`),
  ).toEqual([{ conname: "hq_captain_invitations_capability_check" }, { conname: "hq_captain_invitations_max_redemptions_check" }]);
  expect(
    await run(pg, `SELECT confdeltype FROM pg_constraint WHERE conrelid = 'hq_captain_invitations'::regclass AND contype = 'f' ORDER BY confdeltype`),
  ).toEqual([{ confdeltype: "n" }, { confdeltype: "n" }]);
  // The bare column-level UNIQUE on token_hash: only the hash is ever stored, and it must be unique.
  expect(
    await run(pg, `SELECT conname FROM pg_constraint WHERE conrelid = 'hq_captain_invitations'::regclass AND contype = 'u'`),
  ).toEqual([{ conname: "hq_captain_invitations_token_hash_key" }]);

  expect(await column(pg, "hq_captain_invitation_redemptions", "invitation_id")).toEqual({ data_type: "uuid", is_nullable: "NO" });
  expect(await column(pg, "hq_captain_invitation_redemptions", "user_id")).toEqual({ data_type: "text", is_nullable: "YES" });
  expect(await column(pg, "hq_captain_invitation_redemptions", "redeemed_at")).toEqual({ data_type: "timestamp with time zone", is_nullable: "NO" });
  expect(
    await run(
      pg,
      `SELECT confdeltype FROM pg_constraint WHERE conrelid = 'hq_captain_invitation_redemptions'::regclass AND contype = 'f' AND confrelid = 'hq_captain_invitations'::regclass`,
    ),
  ).toEqual([{ confdeltype: "c" }]);
  expect(
    await run(
      pg,
      `SELECT confdeltype FROM pg_constraint WHERE conrelid = 'hq_captain_invitation_redemptions'::regclass AND contype = 'f' AND confrelid = 'hq_builder_profiles'::regclass`,
    ),
  ).toEqual([{ confdeltype: "n" }]);

  expect(await column(pg, "hq_captain_assignments", "project_id")).toEqual({ data_type: "uuid", is_nullable: "NO" });
  expect(await column(pg, "hq_captain_assignments", "captain_user_id")).toEqual({ data_type: "text", is_nullable: "YES" });
  expect(await column(pg, "hq_captain_assignments", "assigned_at")).toEqual({ data_type: "timestamp with time zone", is_nullable: "NO" });
  expect(await column(pg, "hq_captain_assignments", "assigned_by_user_id")).toEqual({ data_type: "uuid", is_nullable: "YES" });
  expect(await column(pg, "hq_captain_assignments", "unassigned_at")).toEqual({ data_type: "timestamp with time zone", is_nullable: "YES" });
  expect(await column(pg, "hq_captain_assignments", "unassigned_by_user_id")).toEqual({ data_type: "uuid", is_nullable: "YES" });
  expect(await column(pg, "hq_captain_assignments", "reason")).toEqual({ data_type: "text", is_nullable: "YES" });
  expect(
    await run(
      pg,
      `SELECT confdeltype FROM pg_constraint WHERE conrelid = 'hq_captain_assignments'::regclass AND contype = 'f' AND confrelid = 'hq_projects'::regclass`,
    ),
  ).toEqual([{ confdeltype: "c" }]);
  expect(
    await run(
      pg,
      `SELECT confdeltype FROM pg_constraint WHERE conrelid = 'hq_captain_assignments'::regclass AND contype = 'f' AND confrelid = 'hq_builder_profiles'::regclass`,
    ),
  ).toEqual([{ confdeltype: "n" }]);
  // assigned_by_user_id and unassigned_by_user_id: both operator references, both SET NULL.
  expect(
    await run(
      pg,
      `SELECT confdeltype FROM pg_constraint WHERE conrelid = 'hq_captain_assignments'::regclass AND contype = 'f' AND confrelid = 'hq_users'::regclass ORDER BY confdeltype`,
    ),
  ).toEqual([{ confdeltype: "n" }, { confdeltype: "n" }]);

  for (const index of ["hq_captain_assignments_one_current_idx", "hq_captain_assignments_captain_current_idx"]) {
    expect(await exists(pg, index), index).toBe(true);
  }
  // A single non-unique index on hq_captain_invitation_redemptions(invitation_id) would be redundant:
  // the leading column of UNIQUE(invitation_id, user_id) already serves that lookup.
  expect(await exists(pg, "hq_captain_invitation_redemptions_invitation_idx")).toBe(false);
  // The fix round 1 names, retired rather than reused (fix round 2): they must stay gone, not
  // come back under the corrected predicate, or the DROP/CREATE pair would run for real on every
  // future migrate instead of converging to a no-op.
  for (const retired of ["hq_captain_assignments_current_idx", "hq_captain_assignments_captain_idx"]) {
    expect(await exists(pg, retired), retired).toBe(false);
  }
  // The partial unique index enforces at most one current Captain per project, and both partial
  // indexes exclude an orphaned row (captain_user_id set NULL by a deleted account) from counting
  // as "current" — that predicate is what fix round 1 (Important 1) added.
  expect(
    await run(pg, `SELECT indexdef FROM pg_indexes WHERE indexname = 'hq_captain_assignments_one_current_idx'`),
  ).toEqual([
    {
      indexdef: expect.stringMatching(
        /UNIQUE INDEX hq_captain_assignments_one_current_idx ON public\.hq_captain_assignments USING btree \(project_id\) WHERE \(\(unassigned_at IS NULL\) AND \(captain_user_id IS NOT NULL\)\)$/,
      ),
    },
  ]);
  expect(
    await run(pg, `SELECT indexdef FROM pg_indexes WHERE indexname = 'hq_captain_assignments_captain_current_idx'`),
  ).toEqual([
    {
      indexdef: expect.stringMatching(
        /CREATE INDEX hq_captain_assignments_captain_current_idx ON public\.hq_captain_assignments USING btree \(captain_user_id\) WHERE \(\(unassigned_at IS NULL\) AND \(captain_user_id IS NOT NULL\)\)$/,
      ),
    },
  ]);
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
      await expectCaptainSchema(pg);
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
      // hq_luma_sync is in neither list: RESET_STATEMENTS rewinds its single
      // row with a dedicated UPDATE instead of clearing or keeping it.
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
    // The seeded partner-liaison role as scripts/hq/seed.ts wrote it before
    // task T1.2 renamed it, with a card on it.
    await run(
      pg,
      `INSERT INTO hq_people_roles (label, filter_label, color, bg, is_judge, sort)
       VALUES ('Captain','Captains','accent','accent-fill',false,0), ('Judge','Judges','indigo','fill-3',true,1)`,
    );
    await run(pg, `INSERT INTO hq_people (name, role_id) SELECT 'Judge One', id FROM hq_people_roles WHERE label = 'Judge'`);
    await run(pg, `INSERT INTO hq_people (name, role_id) SELECT 'Liaison One', id FROM hq_people_roles WHERE label = 'Captain'`);
  }

  /** hq_builder_profiles exactly as builder-schema.sql created it before task T1.1: email required, no contact_email. */
  async function createOldBuilderProfiles(pg: PGlite) {
    await run(
      pg,
      `CREATE TABLE hq_builder_profiles (
         id text PRIMARY KEY,
         email text NOT NULL,
         name text NOT NULL,
         tier text NOT NULL DEFAULT 'regular' CHECK (tier IN ('regular', 'member')),
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
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
      await createOldBuilderProfiles(pg);
      const roles = await run(pg, `SELECT id, label FROM hq_people_roles ORDER BY label`);
      const liaisonRole = String(roles.find((r) => r.label === "Captain")!.id);
      // First pass: exactly what a live database went through up to now,
      // including the two ALTER TABLE statements over the old-shape table.
      await applyMigrations(pg);
      expect(await column(pg, "hq_builder_profiles", "email")).toEqual({ data_type: "text", is_nullable: "YES" });
      expect(await column(pg, "hq_builder_profiles", "contact_email")).toEqual({ data_type: "text", is_nullable: "YES" });
      await seedAccounts(pg);

      const users = await run(pg, `SELECT id, username, password_hash, password_version, must_change_password FROM hq_users ORDER BY username`);
      const people = await run(pg, `SELECT id, name, builder_user_id, contact, role_id FROM hq_people ORDER BY name`);
      expect(users).toHaveLength(2);
      expect(people).toHaveLength(4);
      expect(await run(pg, `SELECT count(*)::int AS n FROM hq_people WHERE person_id IS NOT NULL`)).toEqual([{ n: 0 }]);

      // The partner-liaison role was renamed in place: same id, same cards,
      // and the capability's name is free for the locked Captain tag.
      expect(await run(pg, `SELECT id, label, filter_label FROM hq_people_roles WHERE id = $1`, [liaisonRole])).toEqual([
        { id: liaisonRole, label: "Partner captain", filter_label: "Partner captains" },
      ]);
      expect(await run(pg, `SELECT count(*)::int AS n FROM hq_people_roles WHERE label = 'Captain'`)).toEqual([{ n: 0 }]);
      expect(await run(pg, `SELECT role_id FROM hq_people WHERE name = 'Liaison One'`)).toEqual([{ role_id: liaisonRole }]);

      // Second pass, over populated tables.
      await applyMigrations(pg);
      await expectIdentitySchema(pg);
      await expectCaptainSchema(pg);
      expect(await run(pg, `SELECT id, username, password_hash, password_version, must_change_password FROM hq_users ORDER BY username`)).toEqual(users);
      expect(await run(pg, `SELECT id, name, builder_user_id, contact, role_id FROM hq_people ORDER BY name`)).toEqual(people);

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
        { name: "Liaison One", linked: false, same_account: null },
        { name: "Second Builder", linked: true, same_account: true },
      ]);

      // Third pass: the backfill matches nothing and creates nothing.
      await applyMigrations(pg);
      expect(await run(pg, `SELECT count(*)::int AS n FROM hq_crm_persons`)).toEqual([{ n: 2 }]);
      expect(await run(pg, `SELECT id, name, builder_user_id, contact, role_id FROM hq_people ORDER BY name`)).toEqual(people);

      // Fourth pass, over a card the backfill would have stamped but must
      // not: another card in the same edition already carries the person, so
      // the one card per person per edition index would refuse the stamp.
      // The guarded backfill skips it and the run succeeds.
      const [emailPerson] = await run(pg, `SELECT id FROM hq_crm_persons WHERE builder_user_id = 'acct-email'`);
      await run(pg, `UPDATE hq_people SET person_id = NULL WHERE builder_user_id = 'acct-email'`);
      await run(
        pg,
        `INSERT INTO hq_people (hackathon_id, name, role_id, person_id)
         SELECT p.hackathon_id, 'Email Builder (roster card)', p.role_id, $1 FROM hq_people p WHERE p.builder_user_id = 'acct-email'`,
        [emailPerson.id],
      );
      await applyMigrations(pg);
      expect(await run(pg, `SELECT person_id FROM hq_people WHERE builder_user_id = 'acct-email'`)).toEqual([{ person_id: null }]);
      expect(await run(pg, `SELECT person_id FROM hq_people WHERE builder_user_id = 'acct-second'`)).not.toEqual([{ person_id: null }]);
      expect(await run(pg, `SELECT count(*)::int AS n FROM hq_people WHERE person_id = $1`, [emailPerson.id])).toEqual([{ n: 1 }]);
    } finally {
      await pg.close();
    }
  }, 30_000);
});

describe("task T4.1: Captain invitations, redemptions and assignments", () => {
  const HACKATHON = 6;

  /** A minimal edition, project, operator and two candidate Captain accounts. */
  async function seed(pg: PGlite) {
    await run(pg, `INSERT INTO hq_hackathons (id, slug, name, start_date, end_date) VALUES (${HACKATHON}, 'edition', 'Edition', '2026-09-14', '2026-10-12')`);
    await run(pg, `INSERT INTO hq_project_statuses (slug, label, color, counts_as_active, sort) VALUES ('green', 'Green', 'green', true, 0)`);
    await run(pg, `INSERT INTO hq_project_forecasts (slug, label, color, sort) VALUES ('committed', 'Committed', 'green', 0)`);
    const [project] = await run(
      pg,
      `INSERT INTO hq_projects (hackathon_id, name, status_id, forecast_id, last_check_in)
       SELECT ${HACKATHON}, 'Project', s.id, f.id, current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f
       RETURNING id::text AS id`,
    );
    const [operator] = await run(pg, `INSERT INTO hq_users (username, display_name, password_hash) VALUES ('op', 'Operator', 'x') RETURNING id::text AS id`);
    await run(pg, `INSERT INTO hq_builder_profiles (id, email, name) VALUES ('cap-1', 'cap1@example.test', 'Cap One'), ('cap-2', 'cap2@example.test', 'Cap Two')`);
    return { projectId: String(project.id), operatorId: String(operator.id) };
  }

  it("refuses a second current assignment for the same project, and allows a historical row plus a new current one", async () => {
    const pg = await createMigratedDatabase();
    try {
      const { projectId, operatorId } = await seed(pg);
      await run(
        pg,
        `INSERT INTO hq_captain_assignments (project_id, captain_user_id, assigned_by_user_id) VALUES ($1, 'cap-1', $2)`,
        [projectId, operatorId],
      );
      await expect(
        run(pg, `INSERT INTO hq_captain_assignments (project_id, captain_user_id, assigned_by_user_id) VALUES ($1, 'cap-2', $2)`, [projectId, operatorId]),
      ).rejects.toThrow(/hq_captain_assignments_one_current_idx/);

      // Unassign, then reassign: the partial unique index only guards the current row.
      await run(
        pg,
        `UPDATE hq_captain_assignments SET unassigned_at = now(), unassigned_by_user_id = $2 WHERE project_id = $1 AND unassigned_at IS NULL`,
        [projectId, operatorId],
      );
      await run(
        pg,
        `INSERT INTO hq_captain_assignments (project_id, captain_user_id, assigned_by_user_id) VALUES ($1, 'cap-2', $2)`,
        [projectId, operatorId],
      );
      expect(
        await run(pg, `SELECT captain_user_id, unassigned_at IS NULL AS current FROM hq_captain_assignments WHERE project_id = $1 ORDER BY assigned_at`, [projectId]),
      ).toEqual([
        { captain_user_id: "cap-1", current: false },
        { captain_user_id: "cap-2", current: true },
      ]);
    } finally {
      await pg.close();
    }
  });

  it("refuses a duplicate redemption of the same invitation by the same account", async () => {
    const pg = await createMigratedDatabase();
    try {
      const { operatorId } = await seed(pg);
      const [invitation] = await run(
        pg,
        `INSERT INTO hq_captain_invitations (token_hash, capability, max_redemptions, expires_at, created_by_user_id)
         VALUES ('hash-1', 'captain', 1, now() + interval '7 days', $1) RETURNING id::text AS id`,
        [operatorId],
      );
      const invitationId = String(invitation.id);
      await run(pg, `INSERT INTO hq_captain_invitation_redemptions (invitation_id, user_id) VALUES ($1, 'cap-1')`, [invitationId]);
      await expect(
        run(pg, `INSERT INTO hq_captain_invitation_redemptions (invitation_id, user_id) VALUES ($1, 'cap-1')`, [invitationId]),
      ).rejects.toThrow(/hq_captain_invitation_redemptions_invitation_id_user_id_key/);
      // A different account redeeming the same invitation is a second, distinct row.
      await run(pg, `INSERT INTO hq_captain_invitation_redemptions (invitation_id, user_id) VALUES ($1, 'cap-2')`, [invitationId]);
      expect(await run(pg, `SELECT count(*)::int AS n FROM hq_captain_invitation_redemptions WHERE invitation_id = $1`, [invitationId])).toEqual([{ n: 2 }]);
    } finally {
      await pg.close();
    }
  });

  it("refuses a non-positive max_redemptions", async () => {
    const pg = await createMigratedDatabase();
    try {
      const { operatorId } = await seed(pg);
      await expect(
        run(
          pg,
          `INSERT INTO hq_captain_invitations (token_hash, capability, max_redemptions, expires_at, created_by_user_id)
           VALUES ('hash-zero', 'captain', 0, now() + interval '7 days', $1)`,
          [operatorId],
        ),
      ).rejects.toThrow(/hq_captain_invitations_max_redemptions_check/);
      await expect(
        run(
          pg,
          `INSERT INTO hq_captain_invitations (token_hash, capability, max_redemptions, expires_at, created_by_user_id)
           VALUES ('hash-negative', 'captain', -1, now() + interval '7 days', $1)`,
          [operatorId],
        ),
      ).rejects.toThrow(/hq_captain_invitations_max_redemptions_check/);
    } finally {
      await pg.close();
    }
  });

  it("refuses a capability other than 'captain'", async () => {
    const pg = await createMigratedDatabase();
    try {
      const { operatorId } = await seed(pg);
      await expect(
        run(
          pg,
          `INSERT INTO hq_captain_invitations (token_hash, capability, max_redemptions, expires_at, created_by_user_id)
           VALUES ('hash-bad-capability', 'admin', 1, now() + interval '7 days', $1)`,
          [operatorId],
        ),
      ).rejects.toThrow(/hq_captain_invitations_capability_check/);
    } finally {
      await pg.close();
    }
  });

  it("keeps a redemption counting toward capacity after the redeeming account is deleted", async () => {
    const pg = await createMigratedDatabase();
    try {
      const { operatorId } = await seed(pg);
      const [invitation] = await run(
        pg,
        `INSERT INTO hq_captain_invitations (token_hash, capability, max_redemptions, expires_at, created_by_user_id)
         VALUES ('hash-deleted-account', 'captain', 5, now() + interval '7 days', $1) RETURNING id::text AS id`,
        [operatorId],
      );
      const invitationId = String(invitation.id);
      await run(pg, `INSERT INTO hq_captain_invitation_redemptions (invitation_id, user_id) VALUES ($1, 'cap-1')`, [invitationId]);
      expect(await run(pg, `SELECT count(*)::int AS n FROM hq_captain_invitation_redemptions WHERE invitation_id = $1`, [invitationId])).toEqual([{ n: 1 }]);

      // Deleting the account the redemption names must not remove the redemption row: capacity
      // already spent must not come back just because the account it was spent by is gone.
      await run(pg, `DELETE FROM hq_builder_profiles WHERE id = 'cap-1'`);
      expect(await run(pg, `SELECT count(*)::int AS n FROM hq_captain_invitation_redemptions WHERE invitation_id = $1`, [invitationId])).toEqual([{ n: 1 }]);
      expect(await run(pg, `SELECT user_id FROM hq_captain_invitation_redemptions WHERE invitation_id = $1`, [invitationId])).toEqual([{ user_id: null }]);
    } finally {
      await pg.close();
    }
  });

  it("lets a project be reassigned after its Captain's account is deleted (Important 1 regression)", async () => {
    const pg = await createMigratedDatabase();
    try {
      const { projectId, operatorId } = await seed(pg);
      await run(
        pg,
        `INSERT INTO hq_captain_assignments (project_id, captain_user_id, assigned_by_user_id) VALUES ($1, 'cap-1', $2)`,
        [projectId, operatorId],
      );

      // The account is deleted without ever being formally unassigned: the row survives with
      // unassigned_at still NULL and captain_user_id set NULL by the FK.
      await run(pg, `DELETE FROM hq_builder_profiles WHERE id = 'cap-1'`);
      expect(
        await run(pg, `SELECT captain_user_id, unassigned_at FROM hq_captain_assignments WHERE project_id = $1`, [projectId]),
      ).toEqual([{ captain_user_id: null, unassigned_at: null }]);

      // A new assignment for the same project must succeed: before the fix round 1 predicate
      // change, the orphaned row still held the partial unique index's one slot per project and
      // this insert raised a unique violation on that index (then named
      // hq_captain_assignments_current_idx), permanently blocking reassignment.
      await run(
        pg,
        `INSERT INTO hq_captain_assignments (project_id, captain_user_id, assigned_by_user_id) VALUES ($1, 'cap-2', $2)`,
        [projectId, operatorId],
      );
      expect(
        await run(
          pg,
          `SELECT captain_user_id FROM hq_captain_assignments WHERE project_id = $1 AND unassigned_at IS NULL AND captain_user_id IS NOT NULL`,
          [projectId],
        ),
      ).toEqual([{ captain_user_id: "cap-2" }]);
      // The orphaned row is still there, untouched by the reassignment (history is append-only);
      // the schema's expectCaptainSchema check above is what proves the partial indexes exclude
      // it by predicate rather than by deleting it.
      expect(
        await run(pg, `SELECT count(*)::int AS n FROM hq_captain_assignments WHERE captain_user_id IS NULL AND unassigned_at IS NULL`),
      ).toEqual([{ n: 1 }]);
    } finally {
      await pg.close();
    }
  });
});

describe("phase 3: the Colosseum source snapshot and the removed challenge", () => {
  const SNAPSHOT_COLUMNS = [
    "category", "tracks", "twitter_handle", "website", "repo_link", "presentation_link",
    "technical_demo_link", "pitch_video_link", "demo_video_link", "image_url",
    "external_hackathon_id", "external_hackathon_slug", "external_hackathon_name",
    "submitted_at", "completion_is_complete", "completion_missing_count",
    "submission_status", "source_status", "source_checked_at", "source_error_code", "source_error_message",
  ];

  it("adds every normalized column, drops the proof columns and the challenge table, on a fresh database applied twice", async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      await applyMigrations(pg);
      const columns = await run(pg, `SELECT column_name FROM information_schema.columns WHERE table_name = 'hq_project_onboarding'`);
      const names = columns.map((row) => String(row.column_name));
      for (const column of SNAPSHOT_COLUMNS) expect(names, column).toContain(column);
      // The ownership-proof challenge is gone, not merely unused.
      expect(names).not.toContain("proof_comment_id");
      expect(names).not.toContain("proof_author_id");
      expect(await run(pg, `SELECT to_regclass('hq_project_challenges') AS table_name`)).toEqual([{ table_name: null }]);
      expect(await run(pg, `SELECT column_name FROM information_schema.columns WHERE table_name='hq_project_members' AND column_name='avatar_url'`))
        .toEqual([{ column_name: "avatar_url" }]);
      // The two status columns carry their check constraints and their
      // honest defaults.
      await expect(run(pg, `INSERT INTO hq_project_onboarding (project_id, hackathon_id, external_id, project_url, slug, raw, owner_user_id, lead_username, submission_status)
        VALUES (gen_random_uuid(), 1, 1, 'x', 'x', '{}', 'x', 'x', 'maybe')`)).rejects.toThrow();
    } finally {
      await pg.close();
    }
  });

  it("backfills the normalized fields of a row that predates them, from its own stored snapshot, and never on a re-run", async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      // A row as it looked before this phase: raw snapshot, no normalized
      // columns filled in. The columns exist by now, so they are nulled
      // explicitly to stand in for the pre-migration state.
      await run(pg, `INSERT INTO hq_hackathons (id, slug, name, start_date, end_date) VALUES (91,'edition','Edition','2026-09-14','2026-10-12')`);
      await run(pg, `INSERT INTO hq_project_statuses (slug,label,color,counts_as_active,sort) VALUES ('s','S','green',true,1)`);
      await run(pg, `INSERT INTO hq_project_forecasts (slug,label,color,sort) VALUES ('f','F','green',1)`);
      await run(pg, `INSERT INTO hq_builder_profiles (id,email,name) VALUES ('acct','a@example.test','Acct')`);
      const [{ id }] = await run(pg, `INSERT INTO hq_projects (hackathon_id,name,status_id,forecast_id,last_check_in)
        SELECT 91,'Old project',s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f RETURNING id::text AS id`);
      const raw = JSON.stringify({ projectType: "HACKATHON", project: {
        id: 90001, hackathonId: 6, slug: "tulip-ledger", category: "Payments & Remittance",
        twitterHandle: "tulipledger", website: null, repoLink: "https://github.com/example-org/tulip-ledger",
        presentationLink: "https://www.example.com/deck", tracks: ["Consumer"],
        image: { url: "https://static.narrative-violation.com/fixtures/projects/tulip-ledger.png" },
        hackathon: { id: 6, slug: "frontier", name: "Frontier" },
      } });
      await run(pg, `INSERT INTO hq_project_onboarding (project_id,hackathon_id,external_id,project_url,slug,raw,owner_user_id,lead_username,verification,category,source_status,source_checked_at)
        VALUES ('${id}',91,90001,'https://colosseum.com/arena/projects/explore/tulip-ledger','tulip-ledger','${raw}'::jsonb,'acct','fictional_builder_1','verified',NULL,'never',NULL)`);

      await applyMigrations(pg);
      const [row] = await run(pg, `SELECT category, twitter_handle, repo_link, presentation_link, image_url, tracks,
        external_hackathon_id, external_hackathon_slug, external_hackathon_name, submission_status, source_status,
        source_checked_at IS NOT NULL AS checked FROM hq_project_onboarding WHERE project_id='${id}'`);
      expect(row).toMatchObject({
        category: "Payments & Remittance", twitter_handle: "tulipledger",
        repo_link: "https://github.com/example-org/tulip-ledger", presentation_link: "https://www.example.com/deck",
        image_url: "https://static.narrative-violation.com/fixtures/projects/tulip-ledger.png",
        tracks: ["Consumer"], external_hackathon_id: 6, external_hackathon_slug: "frontier",
        external_hackathon_name: "Frontier",
        // Deliberately NOT backfilled: no phase 3 status check has run for
        // this row, so "Not checked" is the honest answer.
        submission_status: "not_checked",
        source_status: "ok", checked: true,
      });

      // A later edit survives the next migration: the backfill only ever
      // fills a NULL.
      await run(pg, `UPDATE hq_project_onboarding SET category='Operator corrected' WHERE project_id='${id}'`);
      await applyMigrations(pg);
      expect(await run(pg, `SELECT category FROM hq_project_onboarding WHERE project_id='${id}'`))
        .toEqual([{ category: "Operator corrected" }]);
    } finally {
      await pg.close();
    }
  });
});

describe("phase 5: the reporting tables", () => {
  const HACKATHON = 95;

  async function seed(pg: PGlite) {
    await run(pg, `INSERT INTO hq_hackathons (id, slug, name, start_date, end_date) VALUES (${HACKATHON}, 'reporting', 'Reporting', '2026-09-14', '2026-10-12')`);
    await run(pg, `INSERT INTO hq_project_statuses (slug, label, color, counts_as_active, sort) VALUES ('green', 'Green', 'green', true, 0)`);
    await run(pg, `INSERT INTO hq_project_forecasts (slug, label, color, sort) VALUES ('committed', 'Committed', 'green', 0)`);
    const [project] = await run(
      pg,
      `INSERT INTO hq_projects (hackathon_id, name, status_id, forecast_id, last_check_in)
       SELECT ${HACKATHON}, 'Project', s.id, f.id, current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f
       RETURNING id::text AS id`,
    );
    await run(pg, `INSERT INTO hq_builder_profiles (id, email, name) VALUES ('author-1', 'a1@example.test', 'Author One')`);
    const [period] = await run(
      pg,
      `INSERT INTO hq_reporting_periods (hackathon_id, sequence, mode, start_date, end_date, starts_at, ends_at)
       VALUES (${HACKATHON}, 1, 'weekly', '2026-09-14', '2026-09-20', '2026-09-13T22:00:00Z', '2026-09-20T22:00:00Z')
       RETURNING id::text AS id`,
    );
    return { projectId: String(project.id), periodId: String(period.id) };
  }

  const insertEntry = (projectId: string, periodId: string, extra = "") =>
    `INSERT INTO hq_reporting_entries (project_id, period_id, author_kind, author_id, body${extra ? ", " + extra.split("=")[0] : ""})
     VALUES ('${projectId}', '${periodId}', 'member', 'author-1', 'Shipped the importer'${extra ? ", " + extra.split("=")[1] : ""}) RETURNING id::text AS id`;

  it("creates every reporting table and takes the migration twice without drift", async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      await applyMigrations(pg);
      for (const table of ["hq_reporting_config", "hq_reporting_periods", "hq_reporting_eligibility", "hq_reporting_entries", "hq_reporting_entry_revisions", "hq_reporting_outcomes"]) {
        expect(await exists(pg, table), table).toBe(true);
      }
    } finally {
      await pg.close();
    }
  });

  it("refuses a second period with the same sequence in one edition", async () => {
    const pg = await createMigratedDatabase();
    try {
      await seed(pg);
      await expect(run(
        pg,
        `INSERT INTO hq_reporting_periods (hackathon_id, sequence, mode, start_date, end_date, starts_at, ends_at)
         VALUES (${HACKATHON}, 1, 'weekly', '2026-09-21', '2026-09-27', '2026-09-20T22:00:00Z', '2026-09-27T22:00:00Z')`,
      )).rejects.toThrow(/hq_reporting_periods_hackathon_id_sequence_key/);
    } finally {
      await pg.close();
    }
  });

  it("refuses an empty entry body, one over the 4000 character maximum, and an unknown visibility", async () => {
    const pg = await createMigratedDatabase();
    try {
      const { projectId, periodId } = await seed(pg);
      const insert = (body: string, visibility = "shared") =>
        run(pg, `INSERT INTO hq_reporting_entries (project_id, period_id, author_kind, author_id, body, visibility) VALUES ($1, $2, 'member', 'author-1', $3, $4)`,
          [projectId, periodId, body, visibility]);
      await expect(insert("   ")).rejects.toThrow(/hq_reporting_entries_body_check/);
      await expect(insert("x".repeat(4001))).rejects.toThrow(/hq_reporting_entries_body_check/);
      await expect(insert("fine", "secret")).rejects.toThrow(/hq_reporting_entries_visibility_check/);
      await expect(insert("x".repeat(4000))).resolves.toBeDefined();
    } finally {
      await pg.close();
    }
  });

  it("refuses a second revision of the same entry version, and keeps revisions when the entry is deleted only by cascade", async () => {
    const pg = await createMigratedDatabase();
    try {
      const { projectId, periodId } = await seed(pg);
      const [{ id }] = await run(pg, insertEntry(projectId, periodId));
      await run(pg, `INSERT INTO hq_reporting_entry_revisions (entry_id, version, body, visibility, editor_kind, editor_id) VALUES ($1, 1, 'v1', 'shared', 'member', 'author-1')`, [id]);
      await expect(run(
        pg,
        `INSERT INTO hq_reporting_entry_revisions (entry_id, version, body, visibility, editor_kind, editor_id) VALUES ($1, 1, 'v1 again', 'shared', 'member', 'author-1')`,
        [id],
      )).rejects.toThrow(/hq_reporting_entry_revisions_entry_id_version_key/);
      await run(pg, `DELETE FROM hq_reporting_entries WHERE id = $1`, [id]);
      expect(await run(pg, `SELECT count(*)::int AS n FROM hq_reporting_entry_revisions`)).toEqual([{ n: 0 }]);
    } finally {
      await pg.close();
    }
  });

  it("refuses a second outcome for the same project and period", async () => {
    const pg = await createMigratedDatabase();
    try {
      const { projectId, periodId } = await seed(pg);
      const insert = () => run(
        pg,
        `INSERT INTO hq_reporting_outcomes (period_id, project_id, completed, basis) VALUES ($1, $2, true, 'entry')`,
        [periodId, projectId],
      );
      await insert();
      await expect(insert()).rejects.toThrow(/hq_reporting_outcomes_period_id_project_id_key/);
    } finally {
      await pg.close();
    }
  });

  it("removes every reporting row of a project with the project itself", async () => {
    const pg = await createMigratedDatabase();
    try {
      const { projectId, periodId } = await seed(pg);
      const [{ id }] = await run(pg, insertEntry(projectId, periodId));
      await run(pg, `INSERT INTO hq_reporting_entry_revisions (entry_id, version, body, visibility, editor_kind, editor_id) VALUES ($1, 1, 'v1', 'shared', 'member', 'author-1')`, [id]);
      await run(pg, `INSERT INTO hq_reporting_eligibility (project_id, hackathon_id) VALUES ($1, ${HACKATHON})`, [projectId]);
      await run(pg, `INSERT INTO hq_reporting_outcomes (period_id, project_id, completed, basis) VALUES ($1, $2, true, 'entry')`, [periodId, projectId]);
      await run(pg, `DELETE FROM hq_projects WHERE id = $1`, [projectId]);
      for (const table of ["hq_reporting_entries", "hq_reporting_entry_revisions", "hq_reporting_eligibility", "hq_reporting_outcomes"]) {
        expect(await run(pg, `SELECT count(*)::int AS n FROM ${table}`), table).toEqual([{ n: 0 }]);
      }
    } finally {
      await pg.close();
    }
  });

  it("keeps an entry's author when the authoring account is deleted, the way the audit trail does", async () => {
    const pg = await createMigratedDatabase();
    try {
      const { projectId, periodId } = await seed(pg);
      await run(pg, insertEntry(projectId, periodId));
      await run(pg, `DELETE FROM hq_builder_profiles WHERE id = 'author-1'`);
      expect(await run(pg, `SELECT author_kind, author_id FROM hq_reporting_entries`)).toEqual([{ author_kind: "member", author_id: "author-1" }]);
    } finally {
      await pg.close();
    }
  });
});
