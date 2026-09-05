import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { InterestInput } from "@/lib/colosseum-interest";

vi.mock("server-only", () => ({}));
import { saveColosseumInterest } from "@/lib/hq/colosseum-interest";

const SCHEMA = readFileSync(join(process.cwd(), "scripts/hq/schema.sql"), "utf8");
const INPUT: InterestInput = {
  name: "Test Builder", contactMethod: "telegram", contact: "@testbuilder",
  builtOnSolana: false, path: "beginner",
};

// Exercise the SQL used in production with real PostgreSQL constraints.
// Both schema shapes are constructed from the repository schema, so these
// tests also work before the separate multi-hackathon upgrade is committed.
describe.each([false, true])("Colosseum People storage (scoped: %s)", (scoped) => {
  let pg: PGlite;
  const db = {
    query: async (text: string, params: unknown[] = []) =>
      (await pg.query(text, params)).rows as Record<string, unknown>[],
  };

  beforeAll(async () => {
    pg = new PGlite();
    for (const statement of SCHEMA.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      await db.query(statement);
    }
    if (scoped) {
      await db.query(`CREATE TABLE IF NOT EXISTS hq_hackathons (
        id int PRIMARY KEY, slug text UNIQUE, name text, start_date date, end_date date,
        archived_at timestamptz
      )`);
      for (const table of ["hq_people", "hq_activity"]) {
        await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS hackathon_id int NOT NULL
          REFERENCES hq_hackathons (id) ON DELETE CASCADE`);
      }
    } else {
      await db.query(`ALTER TABLE hq_people DROP COLUMN IF EXISTS hackathon_id`);
      await db.query(`ALTER TABLE hq_activity DROP COLUMN IF EXISTS hackathon_id`);
    }
  });

  beforeEach(async () => {
    await db.query(`TRUNCATE hq_people, hq_people_roles, hq_activity, hq_login_limits CASCADE`);
    if (scoped) {
      await db.query(`TRUNCATE hq_hackathons CASCADE`);
      await db.query(`INSERT INTO hq_hackathons (id, slug, name, start_date, end_date)
        VALUES (6, 'colosseum', 'Colosseum', '2026-09-14', '2026-10-12'),
          (7, 'another', 'Another hackathon', '2026-10-14', '2026-11-12')`);
    }
  });

  afterAll(async () => { await pg.close(); });

  it("adds the answers to the existing People fields and activity feed", async () => {
    expect(await saveColosseumInterest(db, INPUT, "127.0.0.1")).toEqual({ ok: true });
    const [person] = await db.query(`SELECT p.*, r.label FROM hq_people p
      JOIN hq_people_roles r ON r.id = p.role_id`);
    expect(person).toMatchObject({
      name: "Test Builder", contact: "@testbuilder", label: "Builder",
      notes: "Built on Solana before: No",
    });
    if (scoped) expect(person.hackathon_id).toBe(6);
    expect(await db.query(`SELECT message FROM hq_activity`)).toEqual([
      { message: "Test Builder expressed interest in the Colosseum hackathon" },
    ]);
  });

  it("records WhatsApp contact and experienced Solana builders", async () => {
    await saveColosseumInterest(db, {
      ...INPUT, contactMethod: "phone", contact: "+31612345678",
      builtOnSolana: true, path: "experienced",
    }, "127.0.0.1");
    const [person] = await db.query(`SELECT contact, notes FROM hq_people`);
    expect(person).toEqual({
      contact: "+31612345678",
      notes: "Built on Solana before: Yes",
    });
  });

  it("reuses the existing Builder role without changing its HQ settings", async () => {
    const [role] = await db.query(`
      INSERT INTO hq_people_roles (label, filter_label, color, bg, is_judge, sort)
      VALUES ('Builder', 'Our builders', 'green', 'green-fill', false, 42)
      RETURNING id
    `);
    await saveColosseumInterest(db, INPUT, "127.0.0.1");
    expect(await db.query(`SELECT role_id FROM hq_people`)).toEqual([{ role_id: role.id }]);
    expect(await db.query(`SELECT label, filter_label, color, bg, sort FROM hq_people_roles`)).toEqual([
      { label: "Builder", filter_label: "Our builders", color: "green", bg: "green-fill", sort: 42 },
    ]);
  });

  it("deduplicates concurrent retries without overwriting an admin's edits", async () => {
    await Promise.all(Array.from({ length: 4 }, () => saveColosseumInterest(db, INPUT, "127.0.0.1")));
    await db.query(`UPDATE hq_people SET name = 'HQ name', notes = 'Admin note', contact = 'HQ contact'`);
    await db.query(`UPDATE hq_people_roles SET color = 'green', sort = 42`);
    await saveColosseumInterest(db, { ...INPUT, name: "Replacement", builtOnSolana: true }, "127.0.0.1");
    expect(await db.query(`SELECT name, notes, contact FROM hq_people`)).toEqual([
      { name: "HQ name", notes: "Admin note", contact: "HQ contact" },
    ]);
    expect(await db.query(`SELECT color, sort FROM hq_people_roles`)).toEqual([{ color: "green", sort: 42 }]);
    expect(await db.query(`SELECT count(*)::int AS total FROM hq_activity`)).toEqual([{ total: 1 }]);
  });

  it("keeps quotes and SQL-looking names as data", async () => {
    const name = "O'Connor'); DROP TABLE hq_people; --";
    await saveColosseumInterest(db, { ...INPUT, name }, "127.0.0.1");
    expect(await db.query(`SELECT name FROM hq_people`)).toEqual([{ name }]);
  });

  it("writes neither a person nor activity if the atomic write fails", async () => {
    await db.query(`ALTER TABLE hq_activity ADD CONSTRAINT test_activity_block CHECK (message = '')`);
    try {
      await expect(saveColosseumInterest(db, INPUT, "127.0.0.1")).rejects.toThrow();
      expect(await db.query(`SELECT count(*)::int AS total FROM hq_people`)).toEqual([{ total: 0 }]);
    } finally {
      await db.query(`ALTER TABLE hq_activity DROP CONSTRAINT test_activity_block`);
    }
  });

  it("bounds concurrent submissions per source and resets expired windows", async () => {
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) =>
      saveColosseumInterest(db, { ...INPUT, contact: `@builder${i}` }, "127.0.0.1")));
    expect(results.filter((result) => result.ok)).toHaveLength(20);
    expect(await db.query(`SELECT count(*)::int AS total FROM hq_people`)).toEqual([{ total: 20 }]);
    const [counter] = await db.query(`SELECT key, count FROM hq_login_limits`);
    expect(counter.count).toBe(21);
    expect(String(counter.key)).not.toContain("127.0.0.1");
    await db.query(`UPDATE hq_login_limits SET window_start = now() - interval '16 minutes'`);
    expect(await saveColosseumInterest(db, INPUT, "127.0.0.1")).toEqual({ ok: true });
  });

  if (scoped) {
    it.each(["missing", "archived"])("rejects a %s competition instead of picking another", async (state) => {
      if (state === "missing") await db.query(`DELETE FROM hq_hackathons WHERE id = 6`);
      else await db.query(`UPDATE hq_hackathons SET archived_at = now() WHERE id = 6`);
      expect((await saveColosseumInterest(db, INPUT, "127.0.0.1")).ok).toBe(false);
      expect(await db.query(`SELECT count(*)::int AS total FROM hq_people`)).toEqual([{ total: 0 }]);
    });
  }
});
