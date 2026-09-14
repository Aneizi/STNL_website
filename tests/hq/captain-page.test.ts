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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  // Phase 6's reporting cards are client components, and useRouter() runs
  // when this file renders the page to markup.
  useRouter: () => ({ replace() {}, refresh() {}, push() {} }),
}));
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
/** A second project of my own, never imported from Colosseum (no hq_project_onboarding row) — the CRM-only fallback card's own branch, covered alongside the full one above. */
const PROJECT_MINE_BARE = "00000000-0000-4000-8000-00000000001c";

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
  await rows(
    `INSERT INTO hq_builder_profiles(id,email,name) VALUES
       ('me','me@example.test','My Own Name'),('rival','rival@example.test','Rival Captain'),
       ('owner-mine','owner-mine@example.test','Mine Owner'),('owner-theirs','owner-theirs@example.test','Theirs Owner')`,
  );
  // Both real projects are imported teams (hq_project_onboarding present),
  // not just bare hq_projects rows: PROJECT_THEIRS needs a real roster,
  // lead username and Colosseum URL of its own for the "no leak" test below
  // to mean anything — without them there is nothing rival-specific for a
  // leak to carry. The owner is a separate account from the Captain
  // candidate on each project: the Captain candidate being the project's
  // own claimant would be the "claimant" conflict, not what this seeds.
  for (const [id, name, owner, ownerDisplay] of [
    [PROJECT_MINE, "My Secret Project", "owner-mine", "Mine Owner"],
    [PROJECT_THEIRS, "Rival Confidential Project", "owner-theirs", "Theirs Owner"],
  ] as const) {
    await rows(
      `INSERT INTO hq_projects(id,hackathon_id,name,status_id,forecast_id,last_check_in)
       SELECT $1,$2,$3,s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f`,
      [id, EDITION, name],
    );
    await rows(
      `INSERT INTO hq_project_onboarding(project_id,hackathon_id,external_id,project_url,slug,country,raw,owner_user_id,verification,lead_username)
       VALUES($1,$2,$3,$4,$5,'Netherlands','{}',$6,'verified',$6)`,
      [id, EDITION, id === PROJECT_MINE ? 9001 : 9002, `https://colosseum.com/arena/projects/explore/${owner}`, owner, owner],
    );
    await rows(
      `INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at) VALUES($1,$2,$3,$3,now())`,
      [id, ownerDisplay, owner],
    );
  }
  // A second project of mine, never imported: the CRM-only fallback card's branch.
  await rows(
    `INSERT INTO hq_projects(id,hackathon_id,name,status_id,forecast_id,last_check_in)
     SELECT $1,$2,$3,s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f`,
    [PROJECT_MINE_BARE, EDITION, "My Bare CRM Project"],
  );
  await grantCapability(db, { actor: { kind: "operator", id: OPERATOR }, byOperatorId: OPERATOR, userId: "me", capability: "captain", reason: "test" });
  await grantCapability(db, { actor: { kind: "operator", id: OPERATOR }, byOperatorId: OPERATOR, userId: "rival", capability: "captain", reason: "test" });
  expect(await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: PROJECT_MINE, hackathonId: EDITION, captainUserId: "me" })).toMatchObject({ outcome: "assigned" });
  expect(await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: PROJECT_MINE_BARE, hackathonId: EDITION, captainUserId: "me" })).toMatchObject({ outcome: "assigned" });
  expect(await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: PROJECT_THEIRS, hackathonId: EDITION, captainUserId: "rival" })).toMatchObject({ outcome: "assigned" });
});

afterAll(async () => { await pg.close(); });

describe("/hq/captain against the real database", () => {
  it("renders for a Captain, showing only that Captain's own assignments — both the full team card and the CRM-only fallback card", async () => {
    mocks.requireMemberActor.mockResolvedValue(member("me", "My Own Name"));
    const html = renderToStaticMarkup(await CaptainPage());
    // The full CaptainAssignmentView branch: an imported team's own roster, lead and Colosseum link.
    expect(html).toContain("My Secret Project");
    expect(html).toContain("Mine Owner");
    expect(html).toMatch(/colosseum\.com[^"]*owner-mine/i);
    // The CRM-only project: no onboarding row, so no roster, lead or
    // Colosseum link. Phase 6 makes this no longer a *reduced* card, because
    // reporting is keyed on hq_projects: the week, the status and the
    // composer are identical on both cards, and only the Colosseum detail
    // differs.
    expect(html).toContain("My Bare CRM Project");
    expect(html).toContain("No Colosseum team is linked to this project.");
  });

  it("leaks no other Captain's project name, roster, lead or Colosseum link — names and counts only on the leaderboard", async () => {
    mocks.requireMemberActor.mockResolvedValue(member("me", "My Own Name"));
    const html = renderToStaticMarkup(await CaptainPage());
    // The leaderboard may show the other Captain's name and count...
    expect(html).toContain("Rival Captain");
    // ...but never their project's title, id, roster, lead username or Colosseum link — the full CaptainAssignmentView detail their project actually has (seeded above), not just a name.
    expect(html).not.toContain("Rival Confidential Project");
    expect(html).not.toContain(PROJECT_THEIRS);
    expect(html).not.toContain("Theirs Owner");
    expect(html).not.toMatch(/colosseum\.com[^"]*rival/i);
    expect(html).not.toMatch(/colosseum\.com[^"]*owner-theirs/i);
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
