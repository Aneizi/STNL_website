// The member surfaces wired to the central authorization helper, driven the
// way a member reaches them: the two team actions in lib/hq/actions/builders.ts
// and the team page, against real membership, claim and grant rows on
// PGlite. Encodes the phase 1 gate for members: a regular account cannot
// read or change a team through a URL, a body field, a project id or the
// hackathon cookie; a captain grant alone opens nothing; and a lost
// relationship is visible on the next call. Bot requests are deferred to
// phase 7.
import type { PGlite } from "@electric-sql/pglite";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const mocks = vi.hoisted(() => ({
  builderDatabase: vi.fn(),
  currentUser: vi.fn(),
  requireUser: vi.fn(),
  currentMember: vi.fn(),
  requireMember: vi.fn(),
  cookies: vi.fn(),
}));
vi.mock("@/lib/hq/builder-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hq/builder-db")>()),
  builderDatabase: mocks.builderDatabase,
}));
vi.mock("@/lib/hq/auth", () => ({ currentUser: mocks.currentUser, requireUser: mocks.requireUser }));
vi.mock("@/lib/hq/member-auth", () => ({ currentMember: mocks.currentMember, requireMember: mocks.requireMember }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies, headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); },
  // BuilderTeamControls (rendered inside TeamPage) calls useRouter(); only
  // this file's new markup-level render actually exercises that.
  useRouter: () => ({ replace() {}, refresh() {}, push() {} }),
}));

import TeamPage from "@/app/hq/(member)/team/[id]/page";
import { requireMemberActor, type MemberActor } from "@/lib/hq/actor";
import { createBuilderInvite, saveBuilderTeam } from "@/lib/hq/actions/builders";
import type { BuilderDatabase } from "@/lib/hq/builder-db";
import { grantCapability, revokeCapability } from "@/lib/hq/capabilities";
import { assignCaptain, unassignCaptain } from "@/lib/hq/captains";
import { memberTeamView, TEAM_NOT_AVAILABLE } from "@/lib/hq/member-teams";
import { createMigratedDatabase, pgliteBuilderDatabase } from "./helpers/db";

const OPERATOR_ID = "00000000-0000-4000-8000-000000000001";
const EDITION_A = 6;
const EDITION_B = 7;
const PROJECT_A = "00000000-0000-4000-8000-00000000000a"; // edition A, verified, lead-a + member-a + an unclaimed roster row
const PROJECT_B = "00000000-0000-4000-8000-00000000000b"; // edition A, verified, lead-b + cap as a roster member
const PROJECT_C = "00000000-0000-4000-8000-00000000000c"; // edition B, verified, lead-c
const PROJECT_P = "00000000-0000-4000-8000-00000000000d"; // edition A, pending claim by lead-p
const UNKNOWN = "00000000-0000-4000-8000-0000000000ff";
const DENIED = { ok: false, error: TEAM_NOT_AVAILABLE };

let pg: PGlite;
let db: BuilderDatabase;
const rows = async (text: string, values: unknown[] = []) => (await pg.query(text, values)).rows as Record<string, unknown>[];
const grant = (userId: string) => grantCapability(db, { actor: { kind: "operator", id: OPERATOR_ID }, byOperatorId: OPERATOR_ID, userId, capability: "captain", reason: "test" });
const revoke = (userId: string) => revokeCapability(db, { actor: { kind: "operator", id: OPERATOR_ID }, byOperatorId: OPERATOR_ID, userId, capability: "captain", reason: "test" });

/** The signed-in member, as the session reader would hand them over; the actor is built from real grant and identity rows. */
function signIn(id: string) {
  mocks.requireMember.mockResolvedValue({ id, email: null, name: id });
  mocks.currentMember.mockResolvedValue({ id, email: null, name: id });
}
const actorFor = async (id: string): Promise<MemberActor> => { signIn(id); return requireMemberActor(); };
const page = (id: string) => TeamPage({ params: Promise.resolve({ id }) });
const teamState = () => rows("SELECT project_id::text AS id, owner_user_id, verification, stage, lead_username FROM hq_project_onboarding ORDER BY project_id");
const rosterUsernames = (projectId: string) => rows("SELECT colosseum_username FROM hq_project_members WHERE project_id=$1 ORDER BY sort", [projectId]);

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = pgliteBuilderDatabase(pg);
}, 30_000);

beforeEach(async () => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  mocks.builderDatabase.mockReturnValue(db);
  mocks.currentUser.mockResolvedValue(null);
  mocks.cookies.mockResolvedValue({ get: () => undefined });
  await pg.exec("TRUNCATE hq_users, hq_hackathons, hq_builder_profiles, hq_project_statuses, hq_project_forecasts, hq_audit_events, hq_auth_user, hq_login_limits RESTART IDENTITY CASCADE");
  await rows("INSERT INTO hq_users(id,username,display_name,password_hash) VALUES($1,'operator','Operator','unused')", [OPERATOR_ID]);
  await pg.exec(`
    INSERT INTO hq_hackathons(id,slug,name,start_date,end_date) VALUES
      (${EDITION_A},'edition-a','Edition A','2026-09-14','2026-10-12'),
      (${EDITION_B},'edition-b','Edition B','2027-01-01','2027-02-01');
    INSERT INTO hq_hackathon_onboarding(hackathon_id,external_hackathon_id,external_hackathon_slug,projects_open)
      VALUES(${EDITION_A},9006,'edition-a',true),(${EDITION_B},9007,'edition-b',true);
    INSERT INTO hq_builder_profiles(id,email,name) VALUES
      ('lead-a','lead-a@example.test','Lead A'),('member-a',NULL,'Member A'),('lead-b','lead-b@example.test','Lead B'),
      ('lead-c','lead-c@example.test','Lead C'),('lead-p','lead-p@example.test','Lead P'),
      ('cap',NULL,'Captain'),('plain','plain@example.test','Plain');
    INSERT INTO hq_project_statuses(slug,label,color,counts_as_active,sort) VALUES('onboarding','Onboarding','accent',true,100);
    INSERT INTO hq_project_forecasts(slug,label,color,sort) VALUES('unassessed','Not assessed','muted',100);
  `);
  const projects = [
    [PROJECT_A, EDITION_A, "lead-a", "verified", 9001],
    [PROJECT_B, EDITION_A, "lead-b", "verified", 9002],
    [PROJECT_C, EDITION_B, "lead-c", "verified", 9003],
    [PROJECT_P, EDITION_A, "lead-p", "pending", 9004],
  ] as const;
  for (const [id, edition, owner, verification, external] of projects) {
    await rows(`INSERT INTO hq_projects(id,hackathon_id,name,status_id,forecast_id,last_check_in)
      SELECT $1,$2,$3,s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f`, [id, edition, `Project ${owner}`]);
    await rows(`INSERT INTO hq_project_onboarding(project_id,hackathon_id,external_id,project_url,slug,raw,owner_user_id,verification,lead_username,stage)
      VALUES($1,$2,$3,$4,$5,'{}',$5,$6,$5,'mvp')`, [id, edition, external, `https://colosseum.com/arena/projects/explore/${owner}`, owner, verification]);
    await rows("INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at,sort) VALUES($1,$2,$2,$2,now(),0)", [id, owner]);
  }
  await rows("INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at,sort) VALUES($1,'Member A','member_a','member-a',now(),1)", [PROJECT_A]);
  await rows("INSERT INTO hq_project_members(project_id,name,colosseum_username,sort) VALUES($1,'Unclaimed','unclaimed',2)", [PROJECT_A]);
  await rows("INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at,sort) VALUES($1,'Captain','cap_handle','cap',now(),1)", [PROJECT_B]);
});

afterAll(async () => { await pg.close(); });

describe("team actions", () => {
  it("lets the verified team lead change the lead and stage under the team's edition, and no one else on the roster", async () => {
    signIn("lead-a");
    expect(await saveBuilderTeam({ projectId: PROJECT_A, hackathonId: EDITION_A, stage: "live", leadUsername: "member_a" })).toEqual({ ok: true, data: { saved: true } });
    expect(await rows("SELECT o.stage,o.lead_username,p.lead_name FROM hq_project_onboarding o JOIN hq_projects p ON p.id=o.project_id WHERE o.project_id=$1", [PROJECT_A]))
      .toEqual([{ stage: "live", lead_username: "member_a", lead_name: "Member A" }]);
    // A joined teammate is a member, not the lead: the same not-found answer as an outsider.
    signIn("member-a");
    expect(await saveBuilderTeam({ projectId: PROJECT_A, hackathonId: EDITION_A, stage: "idea", leadUsername: "lead-a" })).toEqual(DENIED);
    expect(await createBuilderInvite({ projectId: PROJECT_A, hackathonId: EDITION_A, memberId: UNKNOWN })).toEqual(DENIED);
    expect(await rows("SELECT stage FROM hq_project_onboarding WHERE project_id=$1", [PROJECT_A])).toEqual([{ stage: "live" }]);
  });

  it("answers a foreign team, another edition's team, a pending claim, an unknown id and a crafted body edition identically, and changes nothing", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const before = await teamState();
    const cases: Array<[string, string, number]> = [
      ["lead-a", PROJECT_B, EDITION_A], // someone else's team
      ["lead-a", PROJECT_C, EDITION_A], // another edition's team, under either edition
      ["lead-a", PROJECT_C, EDITION_B],
      ["lead-a", UNKNOWN, EDITION_A],
      ["lead-p", PROJECT_P, EDITION_A], // the claimant's own pending claim
      ["plain", PROJECT_A, EDITION_A],
      ["lead-a", PROJECT_A, EDITION_B], // their own team, crafted edition in the body
      ["lead-a", PROJECT_A, 999],
    ];
    for (const [userId, projectId, hackathonId] of cases) {
      signIn(userId);
      const label = `${userId} ${projectId} ${hackathonId}`;
      expect(await saveBuilderTeam({ projectId, hackathonId, stage: "live", leadUsername: userId }), label).toEqual(DENIED);
      expect(await createBuilderInvite({ projectId, hackathonId, memberId: UNKNOWN }), label).toEqual(DENIED);
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(await teamState()).toEqual(before);
    expect(await rows("SELECT count(*)::int AS n FROM hq_team_invites")).toEqual([{ n: 0 }]);
  });

  it("never reads the hackathon cookie: a tampered value changes no answer", async () => {
    mocks.cookies.mockResolvedValue({ get: () => ({ name: "hq_hackathon", value: String(EDITION_B) }) });
    signIn("lead-a");
    expect(await saveBuilderTeam({ projectId: PROJECT_A, hackathonId: EDITION_A, stage: "beta", leadUsername: "lead-a" })).toEqual({ ok: true, data: { saved: true } });
    expect(await saveBuilderTeam({ projectId: PROJECT_C, hackathonId: EDITION_B, stage: "beta", leadUsername: "lead-c" })).toEqual(DENIED);
    expect(await createBuilderInvite({ projectId: PROJECT_C, hackathonId: EDITION_B, memberId: UNKNOWN })).toEqual(DENIED);
    expect(mocks.cookies).not.toHaveBeenCalled();
  });

  it("gives a captain grant no team action on its own, and no lead-only action through a roster seat", async () => {
    await grant("cap");
    signIn("cap");
    for (const projectId of [PROJECT_A, PROJECT_B, PROJECT_C, UNKNOWN]) {
      expect(await saveBuilderTeam({ projectId, hackathonId: EDITION_A, stage: "live", leadUsername: "cap_handle" }), projectId).toEqual(DENIED);
      expect(await createBuilderInvite({ projectId, hackathonId: EDITION_A, memberId: UNKNOWN }), projectId).toEqual(DENIED);
    }
    expect(await rows("SELECT stage FROM hq_project_onboarding WHERE project_id=$1", [PROJECT_B])).toEqual([{ stage: "mvp" }]);
  });

  it("sees a lost relationship on the very next call", async () => {
    signIn("lead-a");
    const save = () => saveBuilderTeam({ projectId: PROJECT_A, hackathonId: EDITION_A, stage: "beta", leadUsername: "lead-a" });
    expect(await save()).toEqual({ ok: true, data: { saved: true } });
    // The claim loses its verification: the lead is a claimant again, with no team actions.
    await rows("UPDATE hq_project_onboarding SET verification='pending' WHERE project_id=$1", [PROJECT_A]);
    expect(await save()).toEqual(DENIED);
    await rows("UPDATE hq_project_onboarding SET verification='verified' WHERE project_id=$1", [PROJECT_A]);
    expect(await save()).toEqual({ ok: true, data: { saved: true } });
    // Ownership moves to another account.
    await rows("UPDATE hq_project_onboarding SET owner_user_id='plain' WHERE project_id=$1", [PROJECT_A]);
    expect(await save()).toEqual(DENIED);
  });

  it("invites through the central decision, then the Colosseum roster check, and stores only a code hash", async () => {
    const project = {
      projectType: "HACKATHON",
      project: {
        id: 9001, hackathonId: 9006, slug: "lead-a", name: "Project lead-a", description: "", country: "Netherlands",
        hackathon: { id: 9006, slug: "edition-a", name: "Edition A" },
        teamMembers: [
          { username: "lead-a", displayName: "Lead A", avatarUrl: null },
          { username: "member_a", displayName: "Member A", avatarUrl: null },
          { username: "unclaimed", displayName: "Unclaimed", avatarUrl: null },
        ],
      },
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(project), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    const [unclaimed] = await rows("SELECT id::text AS id FROM hq_project_members WHERE project_id=$1 AND colosseum_username='unclaimed'", [PROJECT_A]);
    const memberId = String(unclaimed.id);
    // The teammate is not the lead: denied before anything is fetched.
    signIn("member-a");
    expect(await createBuilderInvite({ projectId: PROJECT_A, hackathonId: EDITION_A, memberId })).toEqual(DENIED);
    expect(fetcher).not.toHaveBeenCalled();
    signIn("lead-a");
    const result = await createBuilderInvite({ projectId: PROJECT_A, hackathonId: EDITION_A, memberId });
    expect(result.ok && result.data.code).toMatch(/^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$/);
    // Phase 3: creating a join link no longer re-reads Colosseum. The seat
    // is a row on the team's own imported roster, and a refresh is a
    // separate, explicit action — so the team lead can hand a teammate a
    // link while Colosseum is down, and one slow upstream request cannot
    // stand between them and their own team.
    expect(fetcher).not.toHaveBeenCalled();
    expect(await rows("SELECT member_id::text AS member_id, created_by, consumed_at FROM hq_team_invites")).toEqual([{ member_id: memberId, created_by: "lead-a", consumed_at: null }]);
    expect(await rosterUsernames(PROJECT_A)).toEqual([{ colosseum_username: "lead-a" }, { colosseum_username: "member_a" }, { colosseum_username: "unclaimed" }]);
  });
});

describe("the team page", () => {
  it("renders the member's own view of a verified team and nothing wider", async () => {
    const view = await memberTeamView(await actorFor("member-a"), PROJECT_A);
    expect(view).toEqual({
      id: PROJECT_A,
      name: "Project lead-a",
      edition: { id: EDITION_A, name: "Edition A" },
      membership: { role: "member", verification: "verified" },
      captain: null,
      projectUrl: "https://colosseum.com/arena/projects/explore/lead-a",
      stage: "mvp",
      lead: { username: "lead-a" },
      source: expect.objectContaining({ submissionStatus: "not_checked", sourceStatus: "never" }),
      roster: [
        { id: expect.any(String), name: "lead-a", username: "lead-a", avatarUrl: null, joined: true },
        { id: expect.any(String), name: "Member A", username: "member_a", avatarUrl: null, joined: true },
        { id: expect.any(String), name: "Unclaimed", username: "unclaimed", avatarUrl: null, joined: false },
      ],
    });
    expect(JSON.stringify(view)).not.toMatch(/owner_user_id|ownerId|lead-a@|description|hackathonName/);
    expect((await memberTeamView(await actorFor("lead-a"), PROJECT_A))?.membership).toEqual({ role: "owner", verification: "verified" });
    await expect(page(PROJECT_A)).resolves.toBeDefined();
  });

  it("shows a claimant their own pending or rejected claim with its status, and grants them no team action", async () => {
    const claimant = await actorFor("lead-p");
    expect((await memberTeamView(claimant, PROJECT_P))?.membership).toEqual({ role: "owner", verification: "pending" });
    await expect(page(PROJECT_P)).resolves.toBeDefined();
    await rows("UPDATE hq_project_onboarding SET verification='rejected' WHERE project_id=$1", [PROJECT_P]);
    expect((await memberTeamView(claimant, PROJECT_P))?.membership).toEqual({ role: "owner", verification: "rejected" });
    expect(await saveBuilderTeam({ projectId: PROJECT_P, hackathonId: EDITION_A, stage: "live", leadUsername: "lead-p" })).toEqual(DENIED);
    // Nobody else sees the claim, and a claim is never anyone else's team.
    expect(await memberTeamView(await actorFor("plain"), PROJECT_P)).toBeNull();
    expect(await memberTeamView(await actorFor("lead-a"), PROJECT_P)).toBeNull();
  });

  it("answers a foreign, other-edition, unknown or malformed id with the same not-found page, whatever the URL says", async () => {
    await grant("cap");
    const cases: Array<[string, string]> = [
      ["plain", PROJECT_A], ["plain", PROJECT_C], ["plain", PROJECT_P], ["plain", UNKNOWN], ["plain", "not-a-uuid"], ["plain", ""],
      ["lead-a", PROJECT_B], ["lead-a", PROJECT_C], ["lead-a", UNKNOWN],
      ["cap", PROJECT_A], ["cap", PROJECT_C], ["cap", UNKNOWN], // the grant opens no page on its own
    ];
    for (const [userId, id] of cases) {
      signIn(userId);
      await expect(page(id), `${userId} ${id}`).rejects.toThrow("NOT_FOUND");
      expect(await memberTeamView(await actorFor(userId), id), `${userId} ${id}`).toBeNull();
    }
    // The roster seat on B is an ordinary membership, and stays one after the grant goes.
    expect((await memberTeamView(await actorFor("cap"), PROJECT_B))?.membership).toEqual({ role: "member", verification: "verified" });
    await revoke("cap");
    expect((await memberTeamView(await actorFor("cap"), PROJECT_B))?.membership).toEqual({ role: "member", verification: "verified" });
    expect(await memberTeamView(await actorFor("cap"), PROJECT_A)).toBeNull();
  });

  it("loses the page on the next request after leaving the roster, without a session change", async () => {
    signIn("member-a");
    await expect(page(PROJECT_A)).resolves.toBeDefined();
    await rows("UPDATE hq_project_members SET builder_user_id=NULL WHERE builder_user_id='member-a'");
    await expect(page(PROJECT_A)).rejects.toThrow("NOT_FOUND");
    expect(mocks.cookies).not.toHaveBeenCalled();
  });

  it("sends a signed-out visitor to sign in with the team URL as the destination", async () => {
    mocks.requireMember.mockImplementation(async (next?: string) => { throw new Error(`REDIRECT:/hq/signin?next=${encodeURIComponent(next ?? "")}`); });
    await expect(page(PROJECT_A)).rejects.toThrow(`REDIRECT:/hq/signin?next=${encodeURIComponent(`/hq/team/${PROJECT_A}`)}`);
  });

  it("shows the team its assigned Captain's display name with no contact (task T4.5), and no Captain again once unassigned", async () => {
    // PROJECT_C, never touched by an earlier test in this file: its owner
    // (lead-c) and roster are exactly as seeded, so this test does not
    // depend on the mutation history the tests above leave on PROJECT_A.
    await rows("INSERT INTO hq_builder_profiles(id,email,name) VALUES('cap-view','cap-view@example.test','Team Captain') ON CONFLICT (id) DO NOTHING");
    await grant("cap-view");
    expect(await assignCaptain(db, { actorOperatorId: OPERATOR_ID, projectId: PROJECT_C, hackathonId: EDITION_B, captainUserId: "cap-view" })).toMatchObject({ outcome: "assigned" });

    expect((await memberTeamView(await actorFor("lead-c"), PROJECT_C))?.captain).toEqual({ displayName: "Team Captain", contact: null });
    // The view model is only half the proof: the team page must actually
    // render the name, not just carry it in an unread prop.
    const html = renderToStaticMarkup(await page(PROJECT_C));
    expect(html).toContain("Team Captain");

    await unassignCaptain(db, { actorOperatorId: OPERATOR_ID, projectId: PROJECT_C, hackathonId: EDITION_B });
    expect((await memberTeamView(await actorFor("lead-c"), PROJECT_C))?.captain).toBeNull();
    expect(renderToStaticMarkup(await page(PROJECT_C))).not.toContain("Team Captain");
  });

  it("shows no Captain to the account watching its own still-unverified claim: only a verified team's own view is populated", async () => {
    const claim = await memberTeamView(await actorFor("lead-p"), PROJECT_P);
    expect(claim?.membership.role).toBe("owner");
    expect(claim?.membership.verification).not.toBe("verified");
    expect(claim?.captain).toBeNull();
  });
});
