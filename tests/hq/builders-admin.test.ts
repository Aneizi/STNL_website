import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), requireHackathon: vi.fn(), getSql: vi.fn(), refreshHq: vi.fn(), hqToday: vi.fn(), activityStmt: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/hq/auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/hq/hackathon", () => ({ requireHackathon: mocks.requireHackathon }));
vi.mock("@/lib/hq/db", () => ({ getSql: mocks.getSql }));
vi.mock("@/lib/hq/actions/util", () => ({ refreshHq: mocks.refreshHq, hqToday: mocks.hqToday, activityStmt: mocks.activityStmt }));

import {
  markBuilderProjectPotential, resolveBuilderImportRequest, reviewBuilderHostRequest,
  reviewBuilderProject, updateBuilderOnboardingConfig, updateBuilderProjectLead, updateBuilderTier,
} from "@/lib/hq/actions/builders-admin";
import { getBuilderAdminData, getBuilderProjectReviews } from "@/lib/hq/builder-admin-queries";
import { addProjectMember, removeProjectMember, updateProjectDetail, updateProjectMember } from "@/lib/hq/actions/projects";

const OPERATOR = "00000000-0000-4000-8000-000000000001";
const PROJECT = "00000000-0000-4000-8000-000000000002";
const OTHER_PROJECT = "00000000-0000-4000-8000-000000000003";
const REQUEST = "00000000-0000-4000-8000-000000000004";
const OTHER_REQUEST = "00000000-0000-4000-8000-000000000005";
const HOST_REQUEST = "00000000-0000-4000-8000-000000000006";
const OTHER_HOST_REQUEST = "00000000-0000-4000-8000-000000000007";
const config = { externalHackathonId: 42, externalHackathonSlug: "competition-42", projectsOpen: false,
  projectsAvailableAt: "", signupUrl: "https://colosseum.com/signup", hostingEnabled: false };
let pg: PGlite;
async function rows(text: string, values: unknown[] = []) { return (await pg.query(text, values)).rows as Record<string, unknown>[]; }

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync(join(process.cwd(), "scripts/hq/schema.sql"), "utf8"));
  await pg.exec(readFileSync(join(process.cwd(), "scripts/hq/builder-schema.sql"), "utf8"));
  await rows(`INSERT INTO hq_users(id,username,display_name,password_hash) VALUES($1,'operator','Operator','unused')`, [OPERATOR]);
  await pg.exec(`
    INSERT INTO hq_hackathons(id,slug,name,start_date,end_date) VALUES
      (11,'selected','Selected competition','2026-09-14','2026-10-12'),
      (12,'other','Other competition','2027-01-01','2027-02-01');
    INSERT INTO hq_builder_profiles(id,email,name) VALUES ('selected','selected@example.test','Selected Builder'),('other','other@example.test','Other Builder');
    INSERT INTO hq_people_roles(label,filter_label,color,bg,is_judge,sort) VALUES('Builder','Builders','accent','accent-fill',false,1);
    INSERT INTO hq_people(hackathon_id,builder_user_id,name,role_id)
      SELECT 11,'selected','Selected Builder',id FROM hq_people_roles;
    INSERT INTO hq_people(hackathon_id,builder_user_id,name,role_id)
      SELECT 12,'other','Other Builder',id FROM hq_people_roles;
    INSERT INTO hq_project_statuses(slug,label,color,counts_as_active,sort) VALUES('active','Active','green',true,1);
    INSERT INTO hq_project_forecasts(slug,label,color,sort) VALUES('likely','Likely','green',1);
    INSERT INTO hq_hackathon_onboarding(hackathon_id,external_hackathon_id,external_hackathon_slug)
      VALUES(11,42,'competition-42'),(12,81,'competition-81');
  `);
  for (const [id, hackathon, owner, external] of [[PROJECT, 11, "selected", 100], [OTHER_PROJECT, 12, "other", 200]] as const) {
    await rows(`INSERT INTO hq_projects(id,hackathon_id,name,status_id,forecast_id,last_check_in)
      SELECT $1,$2,$3,s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f`, [id, hackathon, `${owner} project`]);
    await rows(`INSERT INTO hq_project_onboarding(project_id,hackathon_id,external_id,project_url,slug,country,raw,owner_user_id,lead_username)
      VALUES($1,$2,$3,$4,$5,'Netherlands','{}',$5,$5)`, [id, hackathon, external, `https://colosseum.com/arena/projects/explore/${owner}`, owner]);
    await rows(`INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at)
      VALUES($1,$2,$2,$2,now())`, [id, owner]);
  }
  await rows(`INSERT INTO hq_project_members(project_id,name,colosseum_username) VALUES($1,'Not Joined','notjoined')`, [PROJECT]);
  for (const [id, user, hackathon] of [[REQUEST, "selected", 11], [OTHER_REQUEST, "other", 12]] as const) {
    await rows(`INSERT INTO hq_project_import_requests(id,user_id,hackathon_id,project_url,note) VALUES($1,$2,$3,$4,'Please help import')`, [id, user, hackathon, `https://colosseum.com/arena/projects/explore/${user}`]);
  }
  for (const [id, user, hackathon] of [[HOST_REQUEST, "selected", 11], [OTHER_HOST_REQUEST, "other", 12]] as const) {
    await rows(`INSERT INTO hq_event_host_requests(id,user_id,hackathon_id,title,details) VALUES($1,$2,$3,'Builders meetup','A local builder workshop')`, [id, user, hackathon]);
  }
});

beforeEach(async () => {
  await pg.exec("BEGIN");
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({ id: OPERATOR });
  mocks.requireHackathon.mockResolvedValue({ id: 11, name: "Selected competition" });
  const tagged = (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.reduce((result, part, index) => result + part + (index < values.length ? `$${index + 1}` : ""), "");
    return { text, values, then: (done: (value: unknown) => unknown, fail: (reason: unknown) => unknown) => rows(text, values).then(done, fail) };
  };
  mocks.getSql.mockReturnValue(Object.assign(tagged, {
    transaction: async (queries: { text: string; values: unknown[] }[]) => {
      const results = [];
      for (const query of queries) results.push(await rows(query.text, query.values));
      return results;
    },
  }));
  mocks.hqToday.mockResolvedValue("2026-09-14");
  mocks.activityStmt.mockImplementation((userId: string, hackathonId: number, message: string) => tagged`INSERT INTO hq_activity(user_id,hackathon_id,message) VALUES(${userId}::uuid,${hackathonId},${message})`);
});
afterEach(async () => { await pg.exec("ROLLBACK"); });
afterAll(async () => { await pg.close(); });

describe("builder administration authorization and scoping", () => {
  it.each([
    ["configuration", () => updateBuilderOnboardingConfig(config)],
    ["membership", () => updateBuilderTier("selected", "member")],
    ["verification", () => reviewBuilderProject({ projectId: PROJECT, decision: "verified", reviewedEvidence: true, note: "Confirmed on Colosseum." })],
    ["potential", () => markBuilderProjectPotential(PROJECT, true)],
    ["lead selection", () => updateBuilderProjectLead(PROJECT, "notjoined")],
    ["adding a teammate", () => addProjectMember(PROJECT, "Forged", "")],
    ["removing a teammate", () => removeProjectMember(PROJECT)],
    ["renaming a teammate", () => updateProjectMember(PROJECT, { field: "name", value: "Forged" })],
    ["editing a lead", () => updateProjectDetail(PROJECT, { field: "leadName", value: "Forged" })],
    ["import requests", () => resolveBuilderImportRequest(REQUEST)],
    ["hosting", () => reviewBuilderHostRequest(HOST_REQUEST, "approved")],
    ["admin queries", () => getBuilderAdminData()],
    ["project queries", () => getBuilderProjectReviews()],
  ] as const)("requires an operator session for %s", async (_, action) => {
    mocks.requireUser.mockRejectedValue(new Error("Not an operator"));
    await expect(action()).rejects.toThrow("Not an operator");
    expect(mocks.getSql).not.toHaveBeenCalled();
    expect(mocks.refreshHq).not.toHaveBeenCalled();
  });

  it("queries only the selected hackathon and preserves roster join status", async () => {
    const admin = await getBuilderAdminData();
    expect(admin.accounts.map((account) => account.id)).toEqual(["selected"]);
    expect(admin.hostRequests.map((request) => request.id)).toEqual([HOST_REQUEST]);
    expect(admin.config.externalHackathonId).toBe(42);
    const reviews = await getBuilderProjectReviews();
    expect(reviews.projects.map((project) => project.id)).toEqual([PROJECT]);
    expect(reviews.projects[0].members).toEqual(expect.arrayContaining([
      expect.objectContaining({ username: "selected", joined: true }),
      expect.objectContaining({ username: "notjoined", joined: false }),
    ]));
    expect(reviews.importRequests.map((request) => request.id)).toEqual([REQUEST]);
  });

  it("scopes membership management but saves the tier globally", async () => {
    expect(await updateBuilderTier("other", "member")).toMatchObject({ ok: false });
    expect(await updateBuilderTier("selected", "member")).toEqual({ ok: true });
    expect(await rows("SELECT id,tier FROM hq_builder_profiles ORDER BY id")).toEqual([
      { id: "other", tier: "regular" }, { id: "selected", tier: "member" },
    ]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_users")).toEqual([{ n: 1 }]);
  });

  it("requires documented evidence and records manual approval in project notes", async () => {
    const review = { projectId: PROJECT, decision: "verified", reviewedEvidence: true, note: "Checked Netherlands and roster with the project owner." } as const;
    expect(await reviewBuilderProject({ ...review, reviewedEvidence: false as true })).toMatchObject({ ok: false });
    expect(await reviewBuilderProject({ ...review, note: "" })).toMatchObject({ ok: false });
    expect(await reviewBuilderProject({ ...review, projectId: OTHER_PROJECT })).toMatchObject({ ok: false });
    expect(await reviewBuilderProject(review)).toEqual({ ok: true });
    expect(await rows("SELECT project_id,verification FROM hq_project_onboarding ORDER BY project_id")).toEqual([
      { project_id: PROJECT, verification: "verified" }, { project_id: OTHER_PROJECT, verification: "pending" },
    ]);
    expect(await rows("SELECT body,author_user_id FROM hq_project_notes")).toEqual([
      { body: `Team verified by admin: ${review.note}`, author_user_id: OPERATOR },
    ]);
    expect(await reviewBuilderProject({ ...review, decision: "rejected" })).toEqual({ ok: true });
  });

  it("protects imported identities while allowing contact edits and listed lead selection", async () => {
    const [member] = await rows("SELECT id FROM hq_project_members WHERE project_id=$1 AND colosseum_username='selected'", [PROJECT]);
    const memberId = String(member.id);
    expect(await addProjectMember(PROJECT, "Forged teammate", "")).toMatchObject({ ok: false });
    expect(await removeProjectMember(memberId)).toMatchObject({ ok: false });
    expect(await updateProjectMember(memberId, { field: "name", value: "New identity" })).toMatchObject({ ok: false });
    expect(await updateProjectDetail(PROJECT, { field: "leadName", value: "New lead" })).toMatchObject({ ok: false });
    expect(await updateProjectMember(memberId, { field: "contact", value: "@contact" })).toEqual({ ok: true });
    expect(await updateBuilderProjectLead(PROJECT, "forged")).toMatchObject({ ok: false });
    expect(await updateBuilderProjectLead(OTHER_PROJECT, "other")).toMatchObject({ ok: false });
    expect(await updateBuilderProjectLead(PROJECT, "notjoined")).toEqual({ ok: true });
    expect(await rows("SELECT name,colosseum_username,builder_user_id,contact FROM hq_project_members WHERE id=$1", [memberId])).toEqual([
      { name: "selected", colosseum_username: "selected", builder_user_id: "selected", contact: "@contact" },
    ]);
    expect(await rows("SELECT p.lead_name,o.lead_username FROM hq_projects p JOIN hq_project_onboarding o ON o.project_id=p.id WHERE p.id=$1", [PROJECT])).toEqual([
      { lead_name: "Not Joined", lead_username: "notjoined" },
    ]);
  });

  it("blocks legacy roster and detail edits for another selected hackathon", async () => {
    const [member] = await rows("SELECT id FROM hq_project_members WHERE project_id=$1 LIMIT 1", [OTHER_PROJECT]);
    expect(await addProjectMember(OTHER_PROJECT, "New teammate", "")).toMatchObject({ ok: false });
    expect(await updateProjectMember(String(member.id), { field: "contact", value: "@wrong" })).toMatchObject({ ok: false });
    expect(await removeProjectMember(String(member.id))).toMatchObject({ ok: false });
    expect(await updateProjectDetail(OTHER_PROJECT, { field: "leadContact", value: "@wrong" })).toMatchObject({ ok: false });
    expect(await rows("SELECT count(*)::int AS n FROM hq_activity")).toEqual([{ n: 0 }]);
  });

  it("cannot flag another hackathon's team or resolve its requests", async () => {
    expect(await markBuilderProjectPotential(OTHER_PROJECT, true)).toMatchObject({ ok: false });
    expect(await resolveBuilderImportRequest(OTHER_REQUEST)).toMatchObject({ ok: false });
    expect(await reviewBuilderHostRequest(OTHER_HOST_REQUEST, "approved")).toMatchObject({ ok: false });
    expect(await rows("SELECT count(*)::int AS n FROM hq_activity")).toEqual([{ n: 0 }]);
    expect(await markBuilderProjectPotential(PROJECT, true)).toEqual({ ok: true });
    expect(await resolveBuilderImportRequest(REQUEST)).toEqual({ ok: true });
    expect(await reviewBuilderHostRequest(HOST_REQUEST, "approved")).toEqual({ ok: true });
    expect(await rows("SELECT high_potential FROM hq_project_onboarding WHERE project_id=$1", [PROJECT])).toEqual([{ high_potential: true }]);
    expect(await rows("SELECT status FROM hq_project_import_requests WHERE id=$1", [REQUEST])).toEqual([{ status: "resolved" }]);
    expect(await rows("SELECT status FROM hq_event_host_requests WHERE id=$1", [HOST_REQUEST])).toEqual([{ status: "approved" }]);
  });

  it("keeps external IDs separate and prevents remapping imported teams", async () => {
    expect(await updateBuilderOnboardingConfig({ ...config, externalHackathonId: 81 })).toMatchObject({ ok: false });
    expect(await updateBuilderOnboardingConfig({ ...config, externalHackathonSlug: "other" })).toMatchObject({ ok: false });
    expect(await updateBuilderOnboardingConfig({ ...config, projectsOpen: true, hostingEnabled: true })).toEqual({ ok: true });
    expect(await rows("SELECT hackathon_id,external_hackathon_id,projects_open,hosting_enabled FROM hq_hackathon_onboarding ORDER BY hackathon_id")).toEqual([
      { hackathon_id: 11, external_hackathon_id: 42, projects_open: true, hosting_enabled: true },
      { hackathon_id: 12, external_hackathon_id: 81, projects_open: false, hosting_enabled: false },
    ]);
  });

  it("requires a confirmed external mapping before imports and blocks foreign signup hosts", async () => {
    expect(await updateBuilderOnboardingConfig({ ...config, projectsOpen: true, externalHackathonId: null })).toMatchObject({ ok: false });
    expect(await updateBuilderOnboardingConfig({ ...config, projectsOpen: true, externalHackathonSlug: "" })).toMatchObject({ ok: false });
    expect(await updateBuilderOnboardingConfig({ ...config, signupUrl: "https://colosseum.com.evil.test/signup" })).toMatchObject({ ok: false });
    expect(await updateBuilderOnboardingConfig({ ...config, signupUrl: "javascript:alert(1)" })).toMatchObject({ ok: false });
    expect(await rows("SELECT count(*)::int AS n FROM hq_activity")).toEqual([{ n: 0 }]);
  });
});
