// The classifier lists are fetched as a single aggregated row rather than one
// query per table. These run the real statement against a real Postgres
// (PGlite), so a renamed column, a lost ORDER BY, or a key that stops matching
// the mapper fails here rather than emptying a filter bar in production.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { CLASSIFIERS_SELECT, toClassifiers } from "@/lib/hq/classifiers-sql";

const SCHEMA = readFileSync(join(process.cwd(), "scripts/hq/schema.sql"), "utf8");

const pg = new PGlite();
const query = async (text: string) =>
  (await pg.query(text)).rows as Array<Record<string, unknown>>;

async function classifiers() {
  const [row] = await query(CLASSIFIERS_SELECT);
  return toClassifiers(row ?? {});
}

describe("classifier lists", () => {
  beforeAll(async () => {
    for (const statement of SCHEMA.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      await query(statement);
    }
  });

  it("returns empty lists from an empty database", async () => {
    const empty = await classifiers();
    expect(empty.roles).toEqual([]);
    expect(empty.gates).toEqual([]);
    expect(Object.values(empty).every(Array.isArray)).toBe(true);
  });

  it("reads every list in one statement, in sort order", async () => {
    await query(`INSERT INTO hq_partner_channels (label, sort) VALUES ('Second',1),('First',0)`);
    await query(
      `INSERT INTO hq_event_types (label, supports_end_date, sort)
       VALUES ('Hackathon',true,1),('Workshop',false,0)`,
    );
    await query(
      `INSERT INTO hq_people_roles (label, filter_label, color, bg, is_judge, sort)
       VALUES ('Captain','Captains','accent','accent-fill',false,1),
              ('Judge','Judges','indigo','fill-3',true,0)`,
    );
    await query(
      `INSERT INTO hq_partner_stages (slug,label,drop_color,sort)
       VALUES ('won','Won','green',1),('lead','Lead','blue',0)`,
    );
    await query(
      `INSERT INTO hq_project_statuses (slug,label,color,counts_as_active,sort)
       VALUES ('dropped','Dropped','red',false,1),('green','Green','green',true,0)`,
    );
    await query(
      `INSERT INTO hq_project_forecasts (slug,label,color,sort)
       VALUES ('at-risk','At risk','red',1),('committed','Committed','green',0)`,
    );
    await query(`INSERT INTO hq_submission_gates (label, sort) VALUES ('G2',1),('G1',0)`);
    await query(
      `INSERT INTO hq_exchange_items (slug,label,sort) VALUES ('swag','Swag',1),('cash','Cash',0)`,
    );

    const all = await classifiers();

    expect(all.channels.map((c) => c.label)).toEqual(["First", "Second"]);
    expect(all.eventTypes).toEqual([
      { id: expect.any(String), label: "Workshop", supportsEndDate: false },
      { id: expect.any(String), label: "Hackathon", supportsEndDate: true },
    ]);
    expect(all.roles[0]).toEqual({
      id: expect.any(String),
      label: "Judge",
      filterLabel: "Judges",
      color: "indigo",
      bg: "fill-3",
      isJudge: true,
    });
    expect(all.stages.map((s) => s.slug)).toEqual(["lead", "won"]);
    expect(all.stages[0].dropColor).toBe("blue");
    expect(all.statuses.map((s) => [s.slug, s.countsAsActive])).toEqual([
      ["green", true],
      ["dropped", false],
    ]);
    expect(all.forecasts.map((f) => f.slug)).toEqual(["committed", "at-risk"]);
    expect(all.gates.map((g) => g.label)).toEqual(["G1", "G2"]);
    expect(all.exchangeItems.map((i) => i.slug)).toEqual(["cash", "swag"]);
  });

  it("carries no leftover columns into the payload", async () => {
    const all = await classifiers();
    // `sort` orders the aggregate; shipping it to the client would be noise.
    expect(Object.keys(all.gates[0])).toEqual(["id", "label"]);
  });
});
