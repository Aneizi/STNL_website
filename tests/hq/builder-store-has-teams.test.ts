// The member menu chooses Register team or My teams from hasTeams(), an
// existence check, while the dashboard renders teams(). Both must agree on
// what counts as the account's own team, so each relationship state that
// decides the menu is checked against both reads on a real migrated schema.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { BuilderStore, type BuilderDatabase } from "@/lib/hq/builder-store";
import { createMigratedDatabase, pgliteBuilderDatabase } from "./helpers/db";

const EDITION = 6;
const PROJECT = "00000000-0000-4000-8000-00000000000a";

let pg: PGlite;
let db: BuilderDatabase;
let store: BuilderStore;
const run = async (text: string, values: unknown[] = []) => (await pg.query(text, values)).rows as Record<string, unknown>[];

/** A claim on the one project, owned by `owner` in the given verification state, with the owner's own roster row joined. */
async function claim(owner: string, verification: "verified" | "pending" | "rejected") {
  await run(`INSERT INTO hq_projects(id,hackathon_id,name,status_id,forecast_id,last_check_in)
    SELECT $1,$2,'Tulip Ledger',s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f`, [PROJECT, EDITION]);
  await run(`INSERT INTO hq_project_onboarding(project_id,hackathon_id,external_id,project_url,slug,raw,owner_user_id,verification,lead_username,stage)
    VALUES($1,$2,90001,'https://colosseum.com/arena/projects/explore/tulip-ledger','tulip-ledger','{}',$3,$4,$3,'mvp')`, [PROJECT, EDITION, owner, verification]);
  await run("INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at,sort) VALUES($1,$2,$2,$2,now(),0)", [PROJECT, owner]);
}

/** Both reads, side by side, so a test states the expected answer once. */
async function relationship(userId: string) {
  return { hasTeams: await store.hasTeams(userId), teamIds: (await store.teams(userId)).map((team) => team.id) };
}

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = pgliteBuilderDatabase(pg);
  store = new BuilderStore(db);
}, 30_000);

beforeEach(async () => {
  await pg.exec("TRUNCATE hq_hackathons, hq_builder_profiles, hq_project_statuses, hq_project_forecasts RESTART IDENTITY CASCADE");
  await pg.exec(`
    INSERT INTO hq_hackathons(id,slug,name,start_date,end_date) VALUES(${EDITION},'edition-a','Edition A','2026-09-14','2026-10-12');
    INSERT INTO hq_builder_profiles(id,email,name) VALUES('owner','owner@example.test','Owner'),('joiner',NULL,'Joiner'),('other',NULL,'Other');
    INSERT INTO hq_project_statuses(slug,label,color,counts_as_active,sort) VALUES('onboarding','Onboarding','accent',true,100);
    INSERT INTO hq_project_forecasts(slug,label,color,sort) VALUES('unassessed','Not assessed','muted',100);
  `);
});

afterAll(async () => { await pg.close(); });

describe("hasTeams agrees with teams", () => {
  it("answers false for an account with no claim and no roster row, even when other teams exist", async () => {
    expect(await relationship("owner")).toEqual({ hasTeams: false, teamIds: [] });
    await claim("other", "verified");
    expect(await relationship("owner")).toEqual({ hasTeams: false, teamIds: [] });
  });

  it("answers true for the owner of a verified team", async () => {
    await claim("owner", "verified");
    expect(await relationship("owner")).toEqual({ hasTeams: true, teamIds: [PROJECT] });
  });

  it.each(["pending", "rejected"] as const)("answers true for the owner of a %s claim, which the dashboard lists as well", async (verification) => {
    await claim("owner", verification);
    expect(await relationship("owner")).toEqual({ hasTeams: true, teamIds: [PROJECT] });
  });

  it("answers true for an account that joined a roster row on someone else's team, and false once that row is released", async () => {
    await claim("other", "verified");
    await run("INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at,sort) VALUES($1,'Joiner','joiner',NULL,NULL,1)", [PROJECT]);
    // An unclaimed roster row (an invite not yet redeemed) is no relationship.
    expect(await relationship("joiner")).toEqual({ hasTeams: false, teamIds: [] });
    await run("UPDATE hq_project_members SET builder_user_id='joiner',joined_at=now() WHERE project_id=$1 AND colosseum_username='joiner'", [PROJECT]);
    expect(await relationship("joiner")).toEqual({ hasTeams: true, teamIds: [PROJECT] });
    await run("UPDATE hq_project_members SET builder_user_id=NULL,joined_at=NULL WHERE project_id=$1 AND colosseum_username='joiner'", [PROJECT]);
    expect(await relationship("joiner")).toEqual({ hasTeams: false, teamIds: [] });
  });
});
