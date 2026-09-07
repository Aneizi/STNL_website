import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportedProject } from "@/lib/colosseum-api";
import { BuilderStore, type BuilderDatabase, type BuilderQuery } from "@/lib/hq/builder-store";
import * as builderModule from "@/lib/hq/builder-store";
import type { BuilderUser } from "@/lib/hq/builder-types";
import { applyUpgrades } from "@/scripts/hq/upgrades";

vi.mock("server-only", () => ({}));
const actionMocks = vi.hoisted(() => ({ requireMember: vi.fn() }));
vi.mock("@/lib/hq/member-auth", () => ({ requireMember: actionMocks.requireMember }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { chooseBuilderPath, completeBuilderImport, requestBuilderReview } from "@/lib/hq/actions/builders";

const OWNER: BuilderUser = { id: "auth-owner", email: "owner@example.test", name: "Owner" };
const TEAMMATE: BuilderUser = { id: "auth-teammate", email: "teammate@example.test", name: "Teammate" };
const OUTSIDER: BuilderUser = { id: "auth-outsider", email: "outsider@example.test", name: "Outsider" };
const PROJECT: ImportedProject = {
  externalId: 10103,
  slug: "vaultmind-1",
  name: "VaultMind",
  country: "Netherlands",
  hackathon: { id: 6, slug: "frontier", name: "Frontier" },
  members: [
    { username: "nzarin", displayName: "Naqib", avatarUrl: null },
    { username: "tatmundo", displayName: "Tat", avatarUrl: null },
  ],
  description: "An imported project description.",
  links: { repoLink: "https://github.com/example/project", website: null, presentationLink: null,
    technicalDemoLink: null, pitchVideoLink: null, demoVideoLink: null },
  imageUrl: null,
  raw: { projectType: "HACKATHON", project: { id: 10103, hackathonId: 6, slug: "vaultmind-1" } },
};
const PROOF = { commentId: 9001, authorId: 1234, username: "nzarin" };

type Row = Record<string, unknown>;
let pg: PGlite;
let db: BuilderDatabase;
let store: BuilderStore;

// PGlite owns one connection. Serialize complete transactions so concurrent
// application calls exercise commit/rollback boundaries without interleaving
// BEGIN statements on that single connection.
function databaseAdapter(database: PGlite): BuilderDatabase {
  let queue: Promise<unknown> = Promise.resolve();
  const raw: BuilderQuery = {
    query: async (text, values) => ({ rows: (await database.query(text, values)).rows as Row[] }),
  };
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work, work);
    queue = result.catch(() => undefined);
    return result;
  }
  return {
    query: (text, values) => serialized(() => raw.query(text, values)),
    transaction: work => serialized(async () => {
      await raw.query("BEGIN");
      try {
        const result = await work(raw);
        await raw.query("COMMIT");
        return result;
      } catch (error) {
        await raw.query("ROLLBACK");
        throw error;
      }
    }),
  };
}

async function rows(text: string, values?: unknown[]) { return (await db.query(text, values)).rows; }

async function prepareUsers() {
  await Promise.all([OWNER, TEAMMATE, OUTSIDER].map(user => store.syncAccount(user)));
}

async function importProject(verified = true, project = PROJECT, owner = OWNER, hackathonId = 41) {
  const challenge = await store.issueChallenge(owner, hackathonId, project, "nzarin");
  const id = await store.importTeam(owner, challenge.id, project, "tatmundo", "mvp", verified ? PROOF : null);
  return { id, challenge };
}

async function invite() {
  const { id } = await importProject();
  const team = await store.team(OWNER.id, id);
  const member = team.members.find(item => item.username === "tatmundo")!;
  return { projectId: id, memberId: member.id, code: await store.createInvite(OWNER.id, id, member.id) };
}

beforeAll(async () => {
  pg = new PGlite();
  db = databaseAdapter(pg);
  await pg.exec(readFileSync(join(process.cwd(), "scripts/hq/schema.sql"), "utf8"));
  await applyUpgrades({ query: async text => rows(text) });
  await pg.exec(readFileSync(join(process.cwd(), "scripts/hq/builder-schema.sql"), "utf8"));
  store = new BuilderStore(db);
}, 30_000);

beforeEach(async () => {
  await pg.exec("TRUNCATE hq_hackathons, hq_builder_profiles, hq_login_limits RESTART IDENTITY CASCADE");
  await db.query(`INSERT INTO hq_hackathons(id,slug,name,start_date,end_date) VALUES
    (41,'frontier-local','Spring builders','2098-04-01','2098-05-01'),
    (42,'next-local','Next builders','2099-09-01','2099-10-01'),
    (43,'old-local','Archived builders','2020-01-01','2020-02-01')`);
  await db.query("UPDATE hq_hackathons SET archived_at=now() WHERE id=43");
  await db.query(`INSERT INTO hq_hackathon_onboarding(hackathon_id,external_hackathon_id,external_hackathon_slug,projects_open)
    VALUES(41,6,'frontier',true),(42,7,'next-edition',true)`);
  await prepareUsers();
});

afterAll(async () => { await pg?.close(); });

describe("builder accounts and edition-scoped People", () => {
  it("applies the additive schema repeatedly", async () => {
    await expect(pg.exec(readFileSync(join(process.cwd(), "scripts/hq/builder-schema.sql"), "utf8"))).resolves.toBeDefined();
  });

  it("creates one Builder card per authenticated account and selected edition", async () => {
    await Promise.all(Array.from({ length: 4 }, () => store.syncAccount(OWNER)));
    await Promise.all(Array.from({ length: 3 }, () => store.enroll(OWNER, 42, "builder")));
    expect(await rows(`SELECT p.hackathon_id,p.name,p.contact,r.label FROM hq_people p
      JOIN hq_people_roles r ON r.id=p.role_id WHERE builder_user_id=$1 ORDER BY hackathon_id`, [OWNER.id]))
      .toEqual([
        { hackathon_id: 41, name: "Owner", contact: OWNER.email, label: "Builder" },
        { hackathon_id: 42, name: "Owner", contact: OWNER.email, label: "Builder" },
      ]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_builder_profiles WHERE id=$1", [OWNER.id])).toEqual([{ n: 1 }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_users")).toEqual([{ n: 0 }]);
  });

  it("keeps a supporter's Community role and an operator's card notes after later logins", async () => {
    await store.enroll(OWNER, 41, "supporter");
    await db.query("UPDATE hq_people SET notes='Spoke at our event',contact='@owner' WHERE builder_user_id=$1", [OWNER.id]);
    await store.syncAccount({ ...OWNER, name: "Updated account name" });
    expect(await rows(`SELECT r.label,p.notes,p.contact FROM hq_people p JOIN hq_people_roles r ON r.id=p.role_id
      WHERE p.builder_user_id=$1`, [OWNER.id])).toEqual([{ label: "Community", notes: "Spoke at our event", contact: "@owner" }]);
    await store.enroll(OWNER, 41, "builder");
    expect(await rows(`SELECT r.label FROM hq_people p JOIN hq_people_roles r ON r.id=p.role_id WHERE p.builder_user_id=$1`, [OWNER.id]))
      .toEqual([{ label: "Builder" }]);
  });

  it("rejects unavailable editions without leaving a People card or enrollment", async () => {
    await expect(store.enroll(OWNER, 43, "builder")).rejects.toThrow("available hackathon");
    await expect(store.enroll(OWNER, 999, "builder")).rejects.toThrow("available hackathon");
    expect(await rows("SELECT hackathon_id FROM hq_builder_enrollments WHERE user_id=$1", [OWNER.id])).toEqual([{ hackathon_id: 41 }]);
    expect((await store.hackathons()).map(item => item.id)).toEqual([41, 42]);
  });
});

describe("project challenges and CRM import", () => {
  it("scopes challenge lookup to its owner and lifetime", async () => {
    const challenge = await store.issueChallenge(OWNER, 41, PROJECT, "nzarin");
    expect(await store.challenge(OWNER.id, challenge.id)).toMatchObject({ externalId: 10103, hackathonId: 41, username: "nzarin" });
    await expect(store.challenge(OUTSIDER.id, challenge.id)).rejects.toThrow("expired");
    await db.query("UPDATE hq_project_challenges SET expires_at=now()-interval '1 second' WHERE id=$1", [challenge.id]);
    await expect(store.challenge(OWNER.id, challenge.id)).rejects.toThrow("expired");
  });

  it("imports project, chosen lead, stage, raw data and all teammates together", async () => {
    const { id, challenge } = await importProject();
    expect(await rows(`SELECT p.name,p.lead_name,p.hackathon_id,o.stage,o.verification,o.country,o.raw,
      o.proof_comment_id::int,o.proof_author_id::int FROM hq_projects p JOIN hq_project_onboarding o ON o.project_id=p.id WHERE p.id=$1`, [id]))
      .toEqual([{ name: "VaultMind", lead_name: "Tat", hackathon_id: 41, stage: "mvp", verification: "verified", country: "Netherlands",
        raw: PROJECT.raw, proof_comment_id: PROOF.commentId, proof_author_id: PROOF.authorId }]);
    expect(await rows(`SELECT name,colosseum_username,builder_user_id,joined_at IS NOT NULL AS joined
      FROM hq_project_members WHERE project_id=$1 ORDER BY sort`, [id])).toEqual([
      { name: "Naqib", colosseum_username: "nzarin", builder_user_id: OWNER.id, joined: true },
      { name: "Tat", colosseum_username: "tatmundo", builder_user_id: null, joined: false },
    ]);
    expect(await rows("SELECT consumed_at IS NOT NULL AS consumed FROM hq_project_challenges WHERE id=$1", [challenge.id])).toEqual([{ consumed: true }]);
    await expect(store.importTeam(OWNER, challenge.id, PROJECT, "tatmundo", "mvp", PROOF)).rejects.toThrow("already been used");
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 1 }]);
  });

  it("does not let another account consume a project challenge", async () => {
    const challenge = await store.issueChallenge(OWNER, 41, PROJECT, "nzarin");
    await expect(store.importTeam(OUTSIDER, challenge.id, PROJECT, "tatmundo", "mvp", PROOF)).rejects.toThrow();
    expect(await store.challenge(OWNER.id, challenge.id)).toMatchObject({ id: challenge.id });
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 0 }]);
  });

  it.each([
    { project: { ...PROJECT, country: "Belgium" }, proof: PROOF },
    { project: { ...PROJECT, country: null }, proof: PROOF },
    { project: PROJECT, proof: { ...PROOF, username: "tatmundo" } },
    { project: { ...PROJECT, hackathon: { id: 7, slug: "frontier", name: "Different" } }, proof: PROOF },
    { project: { ...PROJECT, hackathon: { id: 6, slug: "different", name: "Different" } }, proof: PROOF },
    { project: { ...PROJECT, externalId: 8099 }, proof: PROOF },
  ])("rolls back a challenge and all CRM writes for invalid identity/country/config %#", async ({ project, proof }) => {
    const challenge = await store.issueChallenge(OWNER, 41, PROJECT, "nzarin");
    await expect(store.importTeam(OWNER, challenge.id, project, "tatmundo", "idea", proof)).rejects.toThrow();
    expect(await rows("SELECT consumed_at FROM hq_project_challenges WHERE id=$1", [challenge.id])).toEqual([{ consumed_at: null }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_activity")).toEqual([{ n: 0 }]);
  });

  it("rolls back the entire import if its activity write fails", async () => {
    const challenge = await store.issueChallenge(OWNER, 41, PROJECT, "nzarin");
    await db.query("ALTER TABLE hq_activity ADD CONSTRAINT test_activity_failure CHECK (message='')");
    try {
      await expect(store.importTeam(OWNER, challenge.id, PROJECT, "tatmundo", "mvp", PROOF)).rejects.toThrow();
      expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 0 }]);
      expect(await rows("SELECT count(*)::int AS n FROM hq_project_members")).toEqual([{ n: 0 }]);
      expect(await rows("SELECT consumed_at FROM hq_project_challenges WHERE id=$1", [challenge.id])).toEqual([{ consumed_at: null }]);
    } finally { await db.query("ALTER TABLE hq_activity DROP CONSTRAINT test_activity_failure"); }
  });

  it("imports manual-review teams as pending and prevents invites", async () => {
    const { id } = await importProject(false, { ...PROJECT, country: "Belgium" });
    const team = await store.team(OWNER.id, id);
    expect(team.verification).toBe("pending");
    expect(team.members).toHaveLength(2);
    await expect(store.createInvite(OWNER.id, id, team.members[1].id)).rejects.toThrow("verified team");
    expect(await rows("SELECT proof_comment_id,proof_author_id FROM hq_project_onboarding WHERE project_id=$1", [id]))
      .toEqual([{ proof_comment_id: null, proof_author_id: null }]);
  });

  it.each(["pending", "rejected"])("lets proven owners recover a %s claim and removes prior access", async (state) => {
    const { id } = await importProject(false, PROJECT, OUTSIDER);
    if (state === "rejected") await db.query("UPDATE hq_project_onboarding SET verification='rejected' WHERE project_id=$1", [id]);
    await db.query("UPDATE hq_project_onboarding SET high_potential=true WHERE project_id=$1", [id]);
    await db.query("INSERT INTO hq_project_notes(project_id,body) VALUES($1,'Keep this operator review history')", [id]);
    const current = { ...PROJECT, name: "VaultMind updated", description: "Current project details", raw: { snapshot: "current" } };
    const challenge = await store.issueChallenge(OWNER, 41, current, "nzarin");
    const recovered = await store.importTeam(OWNER, challenge.id, current, "tatmundo", "beta", PROOF);
    expect(recovered).toBe(id);
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 1 }]);
    expect(await store.teams(OUTSIDER.id)).toEqual([]);
    await expect(store.team(OUTSIDER.id, id)).rejects.toThrow("your account");
    expect(await store.team(OWNER.id, id)).toMatchObject({ ownerId: OWNER.id, verification: "verified", stage: "beta", name: "VaultMind updated" });
    expect(await rows("SELECT colosseum_username,builder_user_id,joined_at IS NOT NULL AS joined FROM hq_project_members WHERE project_id=$1 ORDER BY sort", [id])).toEqual([
      { colosseum_username: "nzarin", builder_user_id: OWNER.id, joined: true },
      { colosseum_username: "tatmundo", builder_user_id: null, joined: false },
    ]);
    expect(await rows("SELECT high_potential,raw FROM hq_project_onboarding WHERE project_id=$1", [id])).toEqual([{ high_potential: true, raw: current.raw }]);
    expect(await rows("SELECT body FROM hq_project_notes WHERE project_id=$1", [id])).toEqual([{ body: "Keep this operator review history" }]);
  });

  it("updates the current Colosseum link and slug when recovering the same external project", async () => {
    const { id } = await importProject(false, PROJECT, OUTSIDER);
    const current = { ...PROJECT, slug: "vaultmind-current" };
    const challenge = await store.issueChallenge(OWNER, 41, current, "nzarin");
    expect(await store.importTeam(OWNER, challenge.id, current, "tatmundo", "mvp", PROOF)).toBe(id);
    expect(await rows("SELECT slug,project_url FROM hq_project_onboarding WHERE project_id=$1", [id])).toEqual([
      { slug: current.slug, project_url: `https://colosseum.com/arena/projects/explore/${current.slug}` },
    ]);
  });

  it.each(["pending", "rejected"])("does not let a second unverified claimant replace a %s claim", async (state) => {
    const { id } = await importProject(false);
    if (state === "rejected") await db.query("UPDATE hq_project_onboarding SET verification='rejected' WHERE project_id=$1", [id]);
    const challenge = await store.issueChallenge(OUTSIDER, 41, PROJECT, "nzarin");
    await expect(store.importTeam(OUTSIDER, challenge.id, PROJECT, "tatmundo", "idea", null)).rejects.toThrow("awaiting review");
    expect(await store.challenge(OUTSIDER.id, challenge.id)).toMatchObject({ id: challenge.id });
    expect(await rows("SELECT owner_user_id,verification FROM hq_project_onboarding WHERE project_id=$1", [id])).toEqual([{ owner_user_id: OWNER.id, verification: state }]);
    expect(await store.teams(OUTSIDER.id)).toEqual([]);
  });

  it("never replaces an already verified team even with an earlier valid challenge", async () => {
    const challenge = await store.issueChallenge(OUTSIDER, 41, PROJECT, "nzarin");
    const { id } = await importProject();
    await expect(store.issueChallenge(OUTSIDER, 41, PROJECT, "nzarin")).rejects.toThrow("already in HQ");
    await expect(store.importTeam(OUTSIDER, challenge.id, PROJECT, "tatmundo", "live", PROOF)).rejects.toThrow("already verified");
    expect(await rows("SELECT owner_user_id,verification FROM hq_project_onboarding WHERE project_id=$1", [id])).toEqual([{ owner_user_id: OWNER.id, verification: "verified" }]);
    expect(await store.challenge(OUTSIDER.id, challenge.id)).toMatchObject({ id: challenge.id });
  });

  it("revokes all old claim invites and joined identities on recovery", async () => {
    const { id } = await importProject(true, PROJECT, OUTSIDER);
    const teammate = (await store.team(OUTSIDER.id, id)).members.find(member => member.username === "tatmundo")!;
    const code = await store.createInvite(OUTSIDER.id, id, teammate.id);
    await store.redeemInvite(TEAMMATE, code);
    await db.query("UPDATE hq_project_onboarding SET verification='rejected' WHERE project_id=$1", [id]);
    const challenge = await store.issueChallenge(OWNER, 41, PROJECT, "nzarin");
    await store.importTeam(OWNER, challenge.id, PROJECT, "tatmundo", "mvp", PROOF);
    expect(await store.teams(OUTSIDER.id)).toEqual([]);
    expect(await store.teams(TEAMMATE.id)).toEqual([]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_team_invites WHERE project_id=$1", [id])).toEqual([{ n: 0 }]);
    await expect(store.invitation(code)).rejects.toThrow("invalid, expired");
    expect((await store.team(OWNER.id, id)).members.find(member => member.username === "tatmundo")?.joined).toBe(false);
  });

  it("rolls back ownership and roster replacement if recovery cannot be fully committed", async () => {
    const { id } = await importProject(false, PROJECT, OUTSIDER);
    const roster = await rows("SELECT id,colosseum_username,builder_user_id FROM hq_project_members WHERE project_id=$1 ORDER BY sort", [id]);
    const challenge = await store.issueChallenge(OWNER, 41, PROJECT, "nzarin");
    await db.query("ALTER TABLE hq_activity ADD CONSTRAINT test_recovery_failure CHECK (message NOT LIKE '%and verified%')");
    try {
      await expect(store.importTeam(OWNER, challenge.id, PROJECT, "tatmundo", "mvp", PROOF)).rejects.toThrow();
      expect(await rows("SELECT owner_user_id,verification FROM hq_project_onboarding WHERE project_id=$1", [id])).toEqual([{ owner_user_id: OUTSIDER.id, verification: "pending" }]);
      expect(await rows("SELECT id,colosseum_username,builder_user_id FROM hq_project_members WHERE project_id=$1 ORDER BY sort", [id])).toEqual(roster);
      expect(await store.challenge(OWNER.id, challenge.id)).toMatchObject({ id: challenge.id });
    } finally { await db.query("ALTER TABLE hq_activity DROP CONSTRAINT test_recovery_failure"); }
  });

  it.each([
    { change: "projects_open=false", proof: PROOF },
    { change: "projects_available_at=now()+interval '1 day'", proof: PROOF },
    { change: "projects_open=false", proof: null },
    { change: "projects_available_at=now()+interval '1 day'", proof: null },
  ])("rechecks access at consumption after a challenge was issued: $change", async ({ change, proof }) => {
    const challenge = await store.issueChallenge(OWNER, 41, PROJECT, "nzarin");
    await db.query(`UPDATE hq_hackathon_onboarding SET ${change} WHERE hackathon_id=41`);
    await expect(store.importTeam(OWNER, challenge.id, PROJECT, "tatmundo", "idea", proof)).rejects.toThrow("imports are not open");
    expect(await rows("SELECT consumed_at FROM hq_project_challenges WHERE id=$1", [challenge.id])).toEqual([{ consumed_at: null }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 0 }]);
  });

  it("never imports a duplicate external project twice when two challenges race", async () => {
    const a = await store.issueChallenge(OWNER, 41, PROJECT, "nzarin");
    const b = await store.issueChallenge(OUTSIDER, 41, PROJECT, "nzarin");
    const result = await Promise.allSettled([
      store.importTeam(OWNER, a.id, PROJECT, "tatmundo", "mvp", PROOF),
      store.importTeam(OUTSIDER, b.id, PROJECT, "tatmundo", "idea", PROOF),
    ]);
    expect(result.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 1 }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_project_challenges WHERE consumed_at IS NOT NULL")).toEqual([{ n: 1 }]);
  });
});

describe("roster invitations and team access", () => {
  it("only lets a verified owner invite an unclaimed imported teammate", async () => {
    const { id } = await importProject();
    const team = await store.team(OWNER.id, id);
    await expect(store.createInvite(OUTSIDER.id, id, team.members[1].id)).rejects.toThrow();
    await expect(store.createInvite(OWNER.id, id, team.members[0].id)).rejects.toThrow();
    await expect(store.createInvite(OWNER.id, id, "00000000-0000-4000-8000-000000000001")).rejects.toThrow();
    expect(await rows("SELECT count(*)::int AS n FROM hq_team_invites")).toEqual([{ n: 0 }]);
  });

  it("stores a code hash, shows the intended profile, and revokes previous unconsumed codes", async () => {
    const item = await invite();
    expect(await store.invitation(item.code)).toMatchObject({ username: "tatmundo", projectName: "VaultMind", hackathonId: 41 });
    const [{ token_hash }] = await rows("SELECT token_hash FROM hq_team_invites");
    expect(token_hash).not.toBe(item.code.replaceAll("-", ""));
    expect(String(token_hash)).toMatch(/^[a-f0-9]{64}$/);
    const replacement = await store.createInvite(OWNER.id, item.projectId, item.memberId);
    await expect(store.invitation(item.code)).rejects.toThrow("invalid, expired");
    expect(await store.invitation(replacement.toLowerCase().replaceAll("-", " "))).toMatchObject({ memberId: item.memberId });
  });

  it("redeems once, records joined status and adds the teammate to the edition's People", async () => {
    const item = await invite();
    expect(await store.redeemInvite(TEAMMATE, item.code)).toBe(item.projectId);
    expect((await store.team(TEAMMATE.id, item.projectId)).members.every(member => member.joined)).toBe(true);
    expect(await rows("SELECT builder_user_id,joined_at IS NOT NULL AS joined FROM hq_project_members WHERE id=$1", [item.memberId]))
      .toEqual([{ builder_user_id: TEAMMATE.id, joined: true }]);
    expect(await rows("SELECT consumed_by,consumed_at IS NOT NULL AS consumed FROM hq_team_invites")).toEqual([{ consumed_by: TEAMMATE.id, consumed: true }]);
    await expect(store.redeemInvite(OUTSIDER, item.code)).rejects.toThrow("already been used");
    await expect(store.invitation(item.code)).rejects.toThrow("already used");
  });

  it("permits only one successful concurrent redemption", async () => {
    const item = await invite();
    const result = await Promise.allSettled([store.redeemInvite(TEAMMATE, item.code), store.redeemInvite(OUTSIDER, item.code)]);
    expect(result.filter(value => value.status === "fulfilled")).toHaveLength(1);
    const [{ builder_user_id }] = await rows("SELECT builder_user_id FROM hq_project_members WHERE id=$1", [item.memberId]);
    expect([TEAMMATE.id, OUTSIDER.id]).toContain(builder_user_id);
    expect(await rows("SELECT count(*)::int AS n FROM hq_team_invites WHERE consumed_at IS NOT NULL")).toEqual([{ n: 1 }]);
  });

  it.each(["expired", "rejected", "archived"])("rejects %s invites at lookup and redemption", async state => {
    const item = await invite();
    if (state === "expired") await db.query("UPDATE hq_team_invites SET expires_at=now()-interval '1 second'");
    if (state === "rejected") await db.query("UPDATE hq_project_onboarding SET verification='rejected'");
    if (state === "archived") await db.query("UPDATE hq_hackathons SET archived_at=now() WHERE id=41");
    await expect(store.invitation(item.code)).rejects.toThrow();
    await expect(store.redeemInvite(TEAMMATE, item.code)).rejects.toThrow();
    expect(await rows("SELECT builder_user_id FROM hq_project_members WHERE id=$1", [item.memberId])).toEqual([{ builder_user_id: null }]);
  });

  it("does not let the same HQ account claim two identities on a team", async () => {
    const item = await invite();
    await expect(store.redeemInvite(OWNER, item.code)).rejects.toThrow();
    expect(await rows("SELECT consumed_at FROM hq_team_invites")).toEqual([{ consumed_at: null }]);
    expect(await store.invitation(item.code)).toMatchObject({ memberId: item.memberId });
  });

  it("scopes team reads and changes to the authenticated owner or joined teammates", async () => {
    const item = await invite();
    expect(await store.teams(OUTSIDER.id)).toEqual([]);
    await expect(store.team(OUTSIDER.id, item.projectId)).rejects.toThrow("your account");
    await expect(store.updateTeam(OUTSIDER.id, item.projectId, "live", "nzarin")).rejects.toThrow();
    await store.redeemInvite(TEAMMATE, item.code);
    expect(await store.team(TEAMMATE.id, item.projectId)).toMatchObject({ id: item.projectId });
    await expect(store.updateTeam(TEAMMATE.id, item.projectId, "live", "nzarin")).rejects.toThrow();
    await expect(store.updateTeam(OWNER.id, item.projectId, "live", "outsider")).rejects.toThrow();
    await store.updateTeam(OWNER.id, item.projectId, "live", "nzarin");
    expect(await rows("SELECT lead_name FROM hq_projects WHERE id=$1", [item.projectId])).toEqual([{ lead_name: "Naqib" }]);
    expect(await store.team(OWNER.id, item.projectId)).toMatchObject({ stage: "live", leadUsername: "nzarin" });
  });
});

describe("manual requests, dashboard and member privileges", () => {
  it("stores an idempotent manual request without fabricating a CRM project", async () => {
    const url = "https://colosseum.com/arena/projects/explore/unpublished";
    await store.requestReview(OWNER, 42, url, "Project access is not open yet.");
    await store.requestReview(OWNER, 42, url, "Please help us when access opens.");
    await store.requestReview(OUTSIDER, 41, `${url}-other`, "Another account's request.");
    const dashboard = await store.dashboard(OWNER.id);
    expect(dashboard.tier).toBe("regular");
    expect(dashboard.requests).toHaveLength(1);
    expect(dashboard.requests[0]).toMatchObject({ project_url: url, status: "pending", name: "Next builders" });
    expect(await rows("SELECT note FROM hq_project_import_requests WHERE user_id=$1", [OWNER.id]))
      .toEqual([{ note: "Please help us when access opens." }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 0 }]);
    expect(dashboard.enrollments.map(row => row.hackathon_id).sort()).toEqual([41, 42]);
    expect((await store.dashboard(TEAMMATE.id)).requests).toEqual([]);
  });

  it("requires member tier, edition enrollment and the admin hosting toggle together", async () => {
    await expect(store.requestEvent(OWNER.id, 41, "Workshop", "Details about the workshop.")).rejects.toThrow("not open");
    await db.query("UPDATE hq_hackathon_onboarding SET hosting_enabled=true WHERE hackathon_id=41");
    await expect(store.requestEvent(OWNER.id, 41, "Workshop", "Details about the workshop.")).rejects.toThrow("not open");
    await db.query("UPDATE hq_builder_profiles SET tier='member' WHERE id=$1", [OWNER.id]);
    await expect(store.requestEvent(OWNER.id, 42, "Workshop", "Details about the workshop.")).rejects.toThrow("not open");
    await store.requestEvent(OWNER.id, 41, "Workshop", "Details about the workshop.");
    expect((await store.dashboard(OWNER.id)).events).toHaveLength(1);
    expect((await store.dashboard(OUTSIDER.id)).events).toEqual([]);
    await db.query("UPDATE hq_hackathon_onboarding SET hosting_enabled=false WHERE hackathon_id=41");
    await expect(store.requestEvent(OWNER.id, 41, "Another event", "More workshop details.")).rejects.toThrow("not open");
    expect(await rows("SELECT count(*)::int AS n FROM hq_event_host_requests")).toEqual([{ n: 1 }]);
  });

  it("bounds per-account action attempts and resets the expired window", async () => {
    const result = await Promise.allSettled(Array.from({ length: 4 }, () => store.rateLimit(OWNER.id, "test", 3)));
    expect(result.filter(value => value.status === "fulfilled")).toHaveLength(3);
    await expect(store.rateLimit(OUTSIDER.id, "test", 3)).resolves.toBeUndefined();
    await db.query("UPDATE hq_login_limits SET window_start=now()-interval '16 minutes' WHERE key=$1", [`builder:test:${OWNER.id}`]);
    await expect(store.rateLimit(OWNER.id, "test", 3)).resolves.toBeUndefined();
  });
});

describe("public builder actions", () => {
  beforeEach(() => {
    actionMocks.requireMember.mockResolvedValue(OWNER);
    vi.spyOn(builderModule, "builderStore").mockImplementation(() => store);
    vi.spyOn(builderModule, "syncBuilderAccount").mockImplementation(user => store.syncAccount(user));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(["initialize", "join"] as const)("does not enroll an abandoned %s path in a second hackathon", async (path) => {
    expect(await chooseBuilderPath({ hackathonId: 42, path })).toEqual({ ok: true, data: { url: `/hq/${path}?hackathon=42` } });
    expect(await rows("SELECT hackathon_id FROM hq_builder_enrollments WHERE user_id=$1", [OWNER.id])).toEqual([{ hackathon_id: 41 }]);
    expect(await rows("SELECT hackathon_id FROM hq_people WHERE builder_user_id=$1", [OWNER.id])).toEqual([{ hackathon_id: 41 }]);
  });

  it("immediately enrolls a supporter in the selected edition", async () => {
    expect(await chooseBuilderPath({ hackathonId: 42, path: "supporter" })).toEqual({ ok: true, data: { url: "/hq/dashboard" } });
    expect(await rows("SELECT participation FROM hq_builder_enrollments WHERE user_id=$1 AND hackathon_id=42", [OWNER.id])).toEqual([{ participation: "supporter" }]);
  });

  it("allows a manual help request when Colosseum cannot be fetched after a challenge", async () => {
    const challenge = await store.issueChallenge(OWNER, 41, PROJECT, "nzarin");
    const fetcher = vi.fn().mockRejectedValue(new Error("Colosseum is offline"));
    vi.stubGlobal("fetch", fetcher);
    expect(await requestBuilderReview({ hackathonId: 41, url: `https://colosseum.com/arena/projects/explore/${PROJECT.slug}`, note: "I generated a code, but my project no longer loads." })).toEqual({ ok: true, data: { url: "/hq/dashboard" } });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await store.dashboard(OWNER.id)).requests).toHaveLength(1);
    expect(await store.challenge(OWNER.id, challenge.id)).toMatchObject({ id: challenge.id });
  });

  it.each([
    { label: "country changes", current: { ...PROJECT, country: "Belgium" } },
    { label: "selected lead leaves", current: { ...PROJECT, members: PROJECT.members.slice(0, 1) } },
  ])("does not import stale project details when $label during proof lookup", async ({ current }) => {
    const challenge = await store.issueChallenge(OWNER, 41, PROJECT, "nzarin");
    let projectReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      const json = url.pathname.endsWith("/comments") ? {
        comments: [{ id: 9001, projectId: PROJECT.externalId, user: { id: 1234, username: "nzarin" },
          body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: challenge.code }] }] },
          createdAt: new Date().toISOString(), isDeleted: false }],
        offset: 0, hasMore: false,
      } : (() => {
        const snapshot = projectReads++ === 0 ? PROJECT : current;
        return { projectType: "HACKATHON", project: { id: snapshot.externalId, hackathonId: snapshot.hackathon.id,
          slug: snapshot.slug, name: snapshot.name, description: snapshot.description, country: snapshot.country,
          hackathon: snapshot.hackathon, teamMembers: snapshot.members } };
      })();
      return new Response(JSON.stringify(json), { headers: { "Content-Type": "application/json" } });
    }));
    expect(await completeBuilderImport({ challengeId: challenge.id, leadUsername: "tatmundo", stage: "mvp", manual: false })).toMatchObject({ ok: false });
    expect(projectReads).toBeGreaterThanOrEqual(2);
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 0 }]);
    expect(await store.challenge(OWNER.id, challenge.id)).toMatchObject({ id: challenge.id });
  });
});
