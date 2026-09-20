import type { PGlite } from "@electric-sql/pglite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuilderDatabase } from "@/lib/hq/builder-db";

const mocks = vi.hoisted(() => ({ getSql: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/hq/db", () => ({ getSql: mocks.getSql }));

import { Dashboard } from "@/components/hq/dashboard";
import { BuilderStore } from "@/lib/hq/builder-store";
import { getClassifiers, getDashboardProjects, getHackathon, getHackathons, getLumaSyncedAt, getProjects, getSettings, searchAll } from "@/lib/hq/queries";
import { createMigratedDatabase, pgliteBuilderDatabase } from "./helpers/db";

const IMPORTED = "00000000-0000-4000-8000-000000000011";
const MANUAL = "00000000-0000-4000-8000-000000000012";
const OTHER = "00000000-0000-4000-8000-000000000013";
const MISSING = "00000000-0000-4000-8000-000000000014";
let pg: PGlite;
let db: BuilderDatabase;
const statements: { text: string; values: unknown[]; columns: string[] }[] = [];

async function query(text: string, values: unknown[] = []) {
  const result = await db.query(text, values);
  statements.push({ text, values, columns: Object.keys(result.rows[0] ?? {}) });
  return result;
}

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = pgliteBuilderDatabase(pg);
  const tagged = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.reduce((sql, part, index) => sql + part + (index < values.length ? `$${index + 1}` : ""), "");
    return (await query(text, values)).rows;
  };
  mocks.getSql.mockReturnValue(Object.assign(tagged, {
    query: async (text: string, values?: unknown[]) => (await query(text, values)).rows,
  }));
  await pg.exec(`
    INSERT INTO hq_hackathons(id,slug,name,start_date,end_date) VALUES
      (11,'current','Current edition','2026-09-14','2026-10-12'),
      (12,'other','Other edition','2027-01-01','2027-02-01'),
      (13,'archived','Archived edition','2025-01-01','2025-02-01');
    UPDATE hq_hackathons SET archived_at=now() WHERE id=13;
    INSERT INTO hq_builder_profiles(id,email,name) VALUES ('owner','owner@example.test','Owner');
    INSERT INTO hq_project_statuses(slug,label,color,counts_as_active,sort) VALUES ('active','Active','green',true,1);
    INSERT INTO hq_project_forecasts(slug,label,color,sort) VALUES ('likely','Likely','green',1);
    INSERT INTO hq_hackathon_onboarding(hackathon_id,external_hackathon_id,external_hackathon_slug,projects_open)
      VALUES (11,42,'external-edition',true);
    INSERT INTO hq_submission_gates(hackathon_id,label,sort) VALUES (11,'Gate',1);
  `);
  for (const [id, edition, name, created] of [
    [IMPORTED, 11, "Imported team", "2026-09-15"],
    [MANUAL, 11, "Manual team", "2026-09-16"],
    [OTHER, 12, "Other team", "2026-09-17"],
  ] as const) {
    await db.query(`INSERT INTO hq_projects(id,hackathon_id,name,status_id,forecast_id,last_check_in,blocker,created_at)
      SELECT $1,$2,$3,s.id,f.id,'2026-09-01','Needs help',$4 FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f`,
    [id, edition, name, created]);
  }
  await db.query(`INSERT INTO hq_project_onboarding(project_id,hackathon_id,external_id,project_url,slug,description,country,
      raw,owner_user_id,verification,lead_username,category,tracks,website,repo_link,submission_status,submitted_at,
      completion_is_complete,completion_missing_count,source_status,source_checked_at)
    VALUES($1,11,42,'https://colosseum.com/arena/projects/imported','imported','Full description','Netherlands',
      '{"privateRaw":"raw must stay in database"}','owner','verified','owner_handle','Payments',ARRAY['track'],
      'https://example.test','https://github.com/example/project','submitted','2026-09-16T10:00:00.123Z',true,0,'ok','2026-09-16T11:00:00.456Z')`, [IMPORTED]);
  await db.query(`INSERT INTO hq_project_members(project_id,name,contact,colosseum_username,builder_user_id,sort)
    VALUES($1,'Second','@second','second',NULL,2),($1,'Owner','@owner','owner_handle','owner',1)`, [IMPORTED]);
  await db.query("INSERT INTO hq_project_gates(project_id,gate_id) SELECT $1,id FROM hq_submission_gates WHERE hackathon_id=11", [IMPORTED]);
  await db.query("INSERT INTO hq_project_notes(project_id,body) VALUES($1,'Timeline text that the dashboard does not need')", [IMPORTED]);
}, 30_000);

beforeEach(() => { statements.length = 0; });
afterAll(async () => { await pg.close(); });

describe("narrow HQ reads", () => {
  it("preserves every dashboard value, ordering and rendered byte without selecting roster or notes", async () => {
    const narrow = await getDashboardProjects(11);
    expect(statements).toHaveLength(1);
    expect(statements[0].text).not.toMatch(/hq_project_notes|hq_project_members|hq_project_onboarding/);
    expect(statements[0].columns.sort()).toEqual(["blocker", "forecast_slug", "gates", "id", "last_check_in", "name"]);
    const full = await getProjects(11);
    expect(narrow).toEqual(full.map(({ id, name, forecastSlug, gates, lastCheckIn, blocker }) => ({ id, name, forecastSlug, gates, lastCheckIn, blocker })));
    expect(narrow.map(project => project.id)).toEqual([MANUAL, IMPORTED]);
    const props = { settings: await getSettings(11), classifiers: await getClassifiers(11), milestones: [], now: Date.parse("2026-09-20T12:00:00Z"), todayIso: "2026-09-20", todayText: "Sunday 20 September 2026" };
    expect(renderToStaticMarkup(createElement(Dashboard, { ...props, projects: narrow })))
      .toBe(renderToStaticMarkup(createElement(Dashboard, { ...props, projects: full })));
  });

  it("looks up one available edition directly with the same defaults as the list", async () => {
    const store = new BuilderStore({ ...db, query });
    const single = await store.hackathon(11);
    expect(statements).toHaveLength(1);
    expect(statements[0].values).toEqual([11]);
    expect(statements[0].text).toContain("h.id=$1");
    expect(single).toEqual((await store.hackathons()).find(edition => edition.id === 11));
    expect((await store.hackathon(12)).signupUrl).toBe("https://colosseum.com/signup");
    await expect(store.hackathon(13)).rejects.toThrow("Choose an available hackathon.");
    await expect(store.hackathon(999)).rejects.toThrow("Choose an available hackathon.");
  });

  it("batches authorized ids once, excludes raw snapshots, and preserves the complete mapped team", async () => {
    const store = new BuilderStore({ ...db, query });
    const teams = await store.teamsByIds([IMPORTED, MANUAL, MISSING, IMPORTED]);
    expect(statements).toHaveLength(1);
    expect(statements[0].values).toEqual([[IMPORTED, MANUAL, MISSING]]);
    expect(statements[0].columns).not.toContain("raw");
    expect(statements[0].text).not.toContain("o.*");
    expect([...teams.keys()]).toEqual([IMPORTED]);
    expect(teams.get(IMPORTED)).toEqual(await store.teamById(IMPORTED));
    expect(teams.get(IMPORTED)).toMatchObject({
      description: "Full description", verification: "verified", ownerId: "owner", leadUsername: "owner_handle",
      members: [{ name: "Owner", joined: true }, { name: "Second", joined: false }],
      source: { tracks: ["track"], category: "Payments", website: "https://example.test", repoLink: "https://github.com/example/project", submissionStatus: "submitted", submittedAt: "2026-09-16T10:00:00.123Z", completion: { isComplete: true, missingCount: 0 }, sourceCheckedAt: "2026-09-16T11:00:00.456Z" },
    });
    expect(await store.teams("owner")).toEqual([teams.get(IMPORTED)]);
  });

  it("does not issue a team lookup for an empty authorized list", async () => {
    expect(await new BuilderStore({ ...db, query }).teamsByIds([])).toEqual(new Map());
    expect(statements).toHaveLength(0);
  });

  it("preserves timestamp precision from the pg Date parser and retains the never-synced sentinel", async () => {
    await db.query("UPDATE hq_luma_sync SET last_success_at='2026-09-16T11:00:00.789Z' WHERE id=true");
    expect(await getLumaSyncedAt()).toBe("2026-09-16T11:00:00.789Z");
    await db.query("UPDATE hq_luma_sync SET last_success_at='epoch' WHERE id=true");
    expect(await getLumaSyncedAt()).toBeNull();
  });

  it("does not keep reference reads cached outside a React server render", async () => {
    expect((await getHackathon(11))?.name).toBe("Current edition");
    await db.query("UPDATE hq_hackathons SET name='Updated edition' WHERE id=11");
    try {
      expect((await getHackathon(11))?.name).toBe("Updated edition");
      expect((await getHackathons()).find(edition => edition.id === 11)?.name).toBe("Updated edition");
    } finally {
      await db.query("UPDATE hq_hackathons SET name='Current edition' WHERE id=11");
    }
  });
});

describe("batched search", () => {
  beforeEach(async () => {
    await db.query("BEGIN");
    await db.query("UPDATE hq_projects SET name='Needle older project',lead_name='leader-only-match' WHERE id=$1", [IMPORTED]);
    await db.query("UPDATE hq_projects SET name='Needle newer project' WHERE id=$1", [MANUAL]);
    await db.query("UPDATE hq_projects SET name='Needle excluded edition' WHERE id=$1", [OTHER]);
    await pg.exec(`
      INSERT INTO hq_partner_channels(label,sort) VALUES('Search channel',1);
      INSERT INTO hq_partner_stages(slug,label,drop_color,sort) VALUES('search-stage','Search stage','green',1);
      INSERT INTO hq_people_roles(label,filter_label,color,bg,is_judge,sort) VALUES('Search role','Search roles','green','green-fill',false,1);
      INSERT INTO hq_event_types(label,supports_end_date,sort) VALUES('Search event',false,1);
      INSERT INTO hq_partners(hackathon_id,name,channel_id,stage_id,captain_name,created_at)
        SELECT 11,n.name,c.id,s.id,'captain-only-match',n.created::timestamptz
        FROM (VALUES('Needle older partner','2026-09-10'),('Needle newer partner','2026-09-11')) n(name,created),
          hq_partner_channels c,hq_partner_stages s WHERE c.label='Search channel' AND s.slug='search-stage';
      INSERT INTO hq_people(hackathon_id,name,role_id,created_at)
        SELECT 11,n.name,r.id,n.created::timestamptz
        FROM (VALUES('Needle older person','2026-09-12'),('Needle newer person','2026-09-13')) n(name,created),
          hq_people_roles r WHERE r.label='Search role';
      INSERT INTO hq_events(hackathon_id,name,type_id,date)
        SELECT 11,n.name,t.id,n.date::date
        FROM (VALUES('Needle later event','2026-09-19'),('Needle earlier event','2026-09-18')) n(name,date),
          hq_event_types t WHERE t.label='Search event';
    `);
  });
  afterEach(async () => { await db.query("ROLLBACK"); });

  it("uses one query, preserves category priority, each category's order and labels, and excludes other editions", async () => {
    const found = await searchAll("  nEEdle  ", 11);
    expect(statements).toHaveLength(1);
    expect(found.map(({ kind, label, meta }) => ({ kind, label, meta }))).toEqual([
      { kind: "Project", label: "Needle newer project", meta: "" },
      { kind: "Project", label: "Needle older project", meta: "leader-only-match" },
      { kind: "Partner", label: "Needle newer partner", meta: "Search channel" },
      { kind: "Partner", label: "Needle older partner", meta: "Search channel" },
      { kind: "Person", label: "Needle newer person", meta: "Search role" },
      { kind: "Person", label: "Needle older person", meta: "Search role" },
      { kind: "Event", label: "Needle earlier event", meta: "Sep 18" },
      { kind: "Event", label: "Needle later event", meta: "Sep 19" },
    ]);
    expect((await searchAll("leader-only-match", 11)).map(hit => hit.id)).toEqual([IMPORTED]);
    expect((await searchAll("captain-only-match", 11)).every(hit => hit.kind === "Partner")).toBe(true);
  });

  it("returns only twelve hits in total, retaining project priority ahead of newer people and partners", async () => {
    await db.query(`INSERT INTO hq_projects(hackathon_id,name,status_id,forecast_id,last_check_in,created_at)
      SELECT 11,'Needle project ' || n,s.id,f.id,'2026-09-01','2026-09-20'::timestamptz + n * interval '1 second'
      FROM generate_series(1,15) n,hq_project_statuses s,hq_project_forecasts f`);
    const found = await searchAll("Needle", 11);
    expect(statements).toHaveLength(1);
    expect(found.map(hit => hit.label)).toEqual(Array.from({ length: 12 }, (_, index) => `Needle project ${15 - index}`));
    expect(found.every(hit => hit.kind === "Project")).toBe(true);
  });

  it.each(["%", "_", "\\"])("matches %s literally instead of treating it as a LIKE operator", async (character) => {
    await db.query("UPDATE hq_projects SET name=$2 WHERE id=$1", [IMPORTED, `Literal ${character}`]);
    expect((await searchAll(character, 11)).map(hit => hit.id)).toEqual([IMPORTED]);
  });

  it("does not query for a blank search", async () => {
    expect(await searchAll(" \t ", 11)).toEqual([]);
    expect(statements).toHaveLength(0);
  });
});
