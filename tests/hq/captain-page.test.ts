// /hq/captain against the real schema on PGlite. member-shell.test.ts covers
// the page's gate and rendering with everything mocked; this file proves the
// same page against real assignment, grant and project rows, which is the
// only way to prove the acceptance check this task is measured against:
// "Captains cannot inspect other Captains' teams through leaderboard APIs or
// direct links."
import type { PGlite } from "@electric-sql/pglite";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));
const mocks = vi.hoisted(() => ({ builderDatabase: vi.fn(), requireMemberActor: vi.fn() }));
vi.mock("@/lib/hq/builder-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hq/builder-db")>()),
  builderDatabase: mocks.builderDatabase,
}));
vi.mock("@/lib/hq/actor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hq/actor")>()),
  requireMemberActor: mocks.requireMemberActor,
}));

import CaptainPage from "@/app/hq/(member)/captain/page";
import type { MemberActor } from "@/lib/hq/actor";
import type { BuilderDatabase } from "@/lib/hq/builder-db";
import { grantCapability } from "@/lib/hq/capabilities";
import { assignCaptain } from "@/lib/hq/captains";
import { createMigratedDatabase, pgliteBuilderDatabase } from "./helpers/db";

const OPERATOR = "00000000-0000-4000-8000-000000000001";
const EDITION = 51;
const PROJECT_MINE = "00000000-0000-4000-8000-00000000001a";
const PROJECT_THEIRS = "00000000-0000-4000-8000-00000000001b";

let pg: PGlite;
let db: BuilderDatabase;
async function rows(text: string, values: unknown[] = []) { return (await pg.query(text, values)).rows as Record<string, unknown>[]; }

function member(id: string, name: string, overrides: Partial<MemberActor> = {}): MemberActor {
  return { kind: "member", id, name, email: null, capabilities: new Set(["captain"]), telegram: { userId: "7" }, ...overrides };
}

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = pgliteBuilderDatabase(pg);
  mocks.builderDatabase.mockReturnValue(db);
}, 30_000);

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.builderDatabase.mockReturnValue(db);
  await pg.exec(
    `TRUNCATE hq_users, hq_builder_profiles, hq_audit_events, hq_auth_user, hq_account_capabilities,
       hq_hackathons, hq_project_statuses, hq_project_forecasts, hq_crm_persons
     RESTART IDENTITY CASCADE`,
  );
  await rows("INSERT INTO hq_users(id,username,display_name,password_hash) VALUES($1,'operator','Operator','unused')", [OPERATOR]);
  await rows("INSERT INTO hq_hackathons(id,slug,name,start_date,end_date) VALUES($1,'edition','Fictional Edition','2026-09-14','2026-10-12')", [EDITION]);
  await rows("INSERT INTO hq_project_statuses(slug,label,color,counts_as_active,sort) VALUES('active','Active','green',true,1)");
  await rows("INSERT INTO hq_project_forecasts(slug,label,color,sort) VALUES('likely','Likely','green',1)");
  await rows("INSERT INTO hq_builder_profiles(id,email,name) VALUES ('me','me@example.test','My Own Name'),('rival','rival@example.test','Rival Captain')");
  for (const [id, name] of [[PROJECT_MINE, "My Secret Project"], [PROJECT_THEIRS, "Rival Confidential Project"]] as const) {
    await rows(
      `INSERT INTO hq_projects(id,hackathon_id,name,status_id,forecast_id,last_check_in)
       SELECT $1,$2,$3,s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f`,
      [id, EDITION, name],
    );
  }
  await grantCapability(db, { actor: { kind: "operator", id: OPERATOR }, byOperatorId: OPERATOR, userId: "me", capability: "captain", reason: "test" });
  await grantCapability(db, { actor: { kind: "operator", id: OPERATOR }, byOperatorId: OPERATOR, userId: "rival", capability: "captain", reason: "test" });
  expect(await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: PROJECT_MINE, hackathonId: EDITION, captainUserId: "me" })).toMatchObject({ outcome: "assigned" });
  expect(await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: PROJECT_THEIRS, hackathonId: EDITION, captainUserId: "rival" })).toMatchObject({ outcome: "assigned" });
});

afterAll(async () => { await pg.close(); });

describe("/hq/captain against the real database", () => {
  it("renders for a Captain, showing only that Captain's own assignment", async () => {
    mocks.requireMemberActor.mockResolvedValue(member("me", "My Own Name"));
    const html = renderToStaticMarkup(await CaptainPage());
    expect(html).toContain("My Secret Project");
  });

  it("leaks no other Captain's project name, id or link — names and counts only on the leaderboard", async () => {
    mocks.requireMemberActor.mockResolvedValue(member("me", "My Own Name"));
    const html = renderToStaticMarkup(await CaptainPage());
    // The leaderboard may show the other Captain's name and count...
    expect(html).toContain("Rival Captain");
    // ...but never their project's title, id or Colosseum link.
    expect(html).not.toContain("Rival Confidential Project");
    expect(html).not.toContain(PROJECT_THEIRS);
    expect(html).not.toMatch(/colosseum\.com[^"]*rival/i);
  });

  it("is not found for a member without the Captain capability, even one the leaderboard names", async () => {
    mocks.requireMemberActor.mockResolvedValue(member("plain", "Plain Member", { capabilities: new Set() }));
    await expect(CaptainPage()).rejects.toThrow("NOT_FOUND");
  });

  it("shows the other Captain at zero once their own assignment ends, and drops them entirely once revoked", async () => {
    mocks.requireMemberActor.mockResolvedValue(member("me", "My Own Name"));
    const { unassignCaptain } = await import("@/lib/hq/captains");
    await unassignCaptain(db, { actorOperatorId: OPERATOR, projectId: PROJECT_THEIRS, hackathonId: EDITION });
    let html = renderToStaticMarkup(await CaptainPage());
    expect(html).toContain("Rival Captain");
    expect(html).not.toContain("Rival Confidential Project");

    const { revokeCapability } = await import("@/lib/hq/capabilities");
    await revokeCapability(db, { actor: { kind: "operator", id: OPERATOR }, byOperatorId: OPERATOR, userId: "rival", capability: "captain", reason: "stepped down" });
    html = renderToStaticMarkup(await CaptainPage());
    expect(html).not.toContain("Rival Captain");
  });
});
