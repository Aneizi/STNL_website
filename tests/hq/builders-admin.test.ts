import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), requireHackathon: vi.fn(), getSql: vi.fn(), refreshHq: vi.fn(), hqToday: vi.fn(), activityStmt: vi.fn(), builderDatabase: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/hq/auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/hq/hackathon", () => ({ requireHackathon: mocks.requireHackathon }));
vi.mock("@/lib/hq/db", () => ({ getSql: mocks.getSql }));
// inHackathon() stays real: it is the edition rule under test.
vi.mock("@/lib/hq/actions/util", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hq/actions/util")>()),
  refreshHq: mocks.refreshHq, hqToday: mocks.hqToday, activityStmt: mocks.activityStmt,
}));
// The builder-side pool that the capability and person-match actions write
// through. Every test already runs inside BEGIN/ROLLBACK on the one PGlite
// connection, so its transactions become savepoints.
vi.mock("@/lib/hq/builder-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hq/builder-db")>()),
  builderDatabase: mocks.builderDatabase,
}));

import {
  markBuilderProjectPotential, resolveBuilderImportRequest, reviewBuilderHostRequest,
  reviewBuilderProject, updateBuilderOnboardingConfig, updateBuilderProjectLead, updateBuilderTier,
} from "@/lib/hq/actions/builders-admin";
import { grantCaptainCapability, revokeCaptainCapability } from "@/lib/hq/actions/capabilities";
import { correctPersonMatch, createPerson, updatePerson } from "@/lib/hq/actions/people";
import { getBuilderAdminData, getBuilderProjectReviews } from "@/lib/hq/builder-admin-queries";
import type { BuilderQuery } from "@/lib/hq/builder-db";
import { grantCapability } from "@/lib/hq/capabilities";
import { getPeople } from "@/lib/hq/queries";
import {
  addProjectMember, addProjectNote, deleteProject, editProjectNote, logMondayReview, removeProjectMember, saveProjectBlocker,
  setProjectForecast, setProjectStatus, toggleProjectGate, updateProjectDetail, updateProjectMember,
} from "@/lib/hq/actions/projects";
import { BuilderAdmin, BuilderProjectReviews } from "@/components/hq/builder-admin";

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
let queryCalls = 0;
async function rows(text: string, values: unknown[] = []) { return (await pg.query(text, values)).rows as Record<string, unknown>[]; }
const builderDb = {
  query: async (text: string, values?: unknown[]) => ({ rows: await rows(text, values ?? []) }),
  async transaction<T>(work: (db: BuilderQuery) => Promise<T>): Promise<T> {
    await pg.exec("SAVEPOINT action");
    try {
      const result = await work(builderDb);
      await pg.exec("RELEASE SAVEPOINT action");
      return result;
    } catch (error) {
      await pg.exec("ROLLBACK TO SAVEPOINT action");
      throw error;
    }
  },
};

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync(join(process.cwd(), "scripts/hq/schema.sql"), "utf8"));
  await pg.exec(readFileSync(join(process.cwd(), "scripts/hq/member-auth-schema.sql"), "utf8"));
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
  queryCalls = 0;
  mocks.getSql.mockReturnValue(Object.assign(tagged, {
    query: (text: string, values: unknown[] = []) => { queryCalls += 1; return rows(text, values); },
    transaction: async (queries: { text: string; values: unknown[] }[]) => {
      const results = [];
      for (const query of queries) results.push(await rows(query.text, query.values));
      return results;
    },
  }));
  mocks.builderDatabase.mockReturnValue(builderDb);
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
    ["granting Captain", () => grantCaptainCapability("selected", "Leads the cohort")],
    ["revoking Captain", () => revokeCaptainCapability("selected", "Stepped down")],
    ["correcting a person match", () => correctPersonMatch({ personId: PROJECT, toUserId: null, reason: "Wrong person" })],
  ] as const)("requires an operator session for %s", async (_, action) => {
    mocks.requireUser.mockRejectedValue(new Error("Not an operator"));
    await expect(action()).rejects.toThrow("Not an operator");
    expect(mocks.getSql).not.toHaveBeenCalled();
    expect(mocks.builderDatabase).not.toHaveBeenCalled();
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

  it("answers a record from another edition exactly like a missing one in every project state action and the People editor", async () => {
    const MISSING = "00000000-0000-4000-8000-0000000000ff";
    const [note] = await rows("INSERT INTO hq_project_notes(project_id,body) VALUES($1,'Other note') RETURNING id::text AS id", [OTHER_PROJECT]);
    const [card] = await rows("SELECT id::text AS id FROM hq_people WHERE builder_user_id='other'");
    const [gate] = await rows("INSERT INTO hq_submission_gates(hackathon_id,label) VALUES(12,'Deck ready') RETURNING id::text AS id");
    const attempts: Array<[string, (id: string) => Promise<unknown>]> = [
      ["status", (id) => setProjectStatus(id, "active")],
      ["forecast", (id) => setProjectForecast(id, "likely")],
      ["gate", (id) => toggleProjectGate(id, String(gate.id), true)],
      ["blocker", (id) => saveProjectBlocker(id, "Blocked")],
      ["note", (id) => addProjectNote(id, "A note")],
      ["monday review", (id) => logMondayReview(id, "Still blocked")],
      ["delete", (id) => deleteProject(id)],
      ["detail", (id) => updateProjectDetail(id, { field: "leadContact", value: "@wrong" })],
      ["teammate", (id) => addProjectMember(id, "New teammate", "")],
    ];
    for (const [label, attempt] of attempts) {
      const foreign = await attempt(OTHER_PROJECT);
      expect(foreign, label).toMatchObject({ ok: false });
      expect(foreign, label).toEqual(await attempt(MISSING));
    }
    expect(await editProjectNote(String(note.id), "Edited")).toEqual(await editProjectNote(MISSING, "Edited"));
    expect(await updatePerson(String(card.id), { field: "org", value: "Forged" })).toEqual(await updatePerson(MISSING, { field: "org", value: "Forged" }));
    expect(await updatePerson(MISSING, { field: "org", value: "Forged" })).toMatchObject({ ok: false });
    // Nothing moved: no activity, no touch, no note, no edit, no deletion, no card change.
    expect(await rows("SELECT count(*)::int AS n FROM hq_activity")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 2 }]);
    expect(await rows("SELECT body,edited_at FROM hq_project_notes")).toEqual([{ body: "Other note", edited_at: null }]);
    expect(await rows("SELECT blocker,touched_by_user_id FROM hq_projects WHERE id=$1", [OTHER_PROJECT])).toEqual([{ blocker: "", touched_by_user_id: null }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_project_gates")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT org FROM hq_people WHERE id=$1", [card.id])).toEqual([{ org: "" }]);
    expect(mocks.refreshHq).not.toHaveBeenCalled();
    // The cookie names the edition the operator works in and authorizes nothing: once the other edition is selected the same ids answer, and the first edition's do not.
    mocks.requireHackathon.mockResolvedValue({ id: 12, name: "Other competition" });
    expect(await setProjectStatus(OTHER_PROJECT, "active")).toEqual({ ok: true });
    expect(await editProjectNote(String(note.id), "Edited")).toEqual({ ok: true });
    expect(await updatePerson(String(card.id), { field: "org", value: "Real org" })).toEqual({ ok: true });
    expect(await setProjectStatus(PROJECT, "active")).toEqual({ ok: false });
    expect(await updatePerson((await rows("SELECT id::text AS id FROM hq_people WHERE builder_user_id='selected'"))[0].id as string, { field: "org", value: "Forged" })).toMatchObject({ ok: false });
    expect(await rows("SELECT hackathon_id FROM hq_activity ORDER BY created_at")).toEqual([{ hackathon_id: 12 }, { hackathon_id: 12 }, { hackathon_id: 12 }]);
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

describe("accounts without a login email in Admin", () => {
  const PLACEHOLDER = "9007199254740993@telegram.placeholder.invalid";
  const TG_PROJECT = "00000000-0000-4000-8000-0000000000aa";

  beforeEach(async () => {
    await rows(`INSERT INTO hq_auth_user(id,name,email,"emailVerified") VALUES
      ('tg-only','Telegram Builder',$1,false),('tg-plain','Handle-less Builder','9007199254740994@telegram.placeholder.invalid',false)`, [PLACEHOLDER]);
    await rows(`INSERT INTO hq_auth_telegram_identity(user_id,provider_subject,telegram_user_id,username) VALUES
      ('tg-only','subject-1',9007199254740993,'tg_handle'),('tg-plain','subject-2',9007199254740994,NULL)`);
    await rows(`INSERT INTO hq_builder_profiles(id,email,contact_email,name) VALUES
      ('tg-only',NULL,'reach-me@example.test','Telegram Builder'),('tg-plain',NULL,NULL,'Handle-less Builder')`);
    await rows("INSERT INTO hq_people(hackathon_id,builder_user_id,name,role_id) SELECT 11,'tg-only','Telegram Builder',id FROM hq_people_roles");
    await rows("INSERT INTO hq_people(hackathon_id,builder_user_id,name,role_id) SELECT 11,'tg-plain','Handle-less Builder',id FROM hq_people_roles");
    await rows("INSERT INTO hq_event_host_requests(user_id,hackathon_id,title,details) VALUES('tg-only',11,'Telegram meetup','A workshop')");
    await rows("INSERT INTO hq_project_import_requests(user_id,hackathon_id,project_url,note) VALUES('tg-plain',11,'https://colosseum.com/arena/projects/explore/tg-plain','Please help')");
    await rows(`INSERT INTO hq_projects(id,hackathon_id,name,status_id,forecast_id,last_check_in)
      SELECT $1,11,'Telegram project',s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f`, [TG_PROJECT]);
    await rows(`INSERT INTO hq_project_onboarding(project_id,hackathon_id,external_id,project_url,slug,raw,owner_user_id,lead_username)
      VALUES($1,11,300,'https://colosseum.com/arena/projects/explore/tg-only','tg-only','{}','tg-only','tg-only')`, [TG_PROJECT]);
  });

  it("carries the Telegram identity and the contact email apart from the login email, never the placeholder", async () => {
    const admin = await getBuilderAdminData();
    expect(admin.accounts.find((account) => account.id === "tg-only")).toMatchObject({ email: null, telegram: { username: "tg_handle" }, contactEmail: "reach-me@example.test" });
    expect(admin.accounts.find((account) => account.id === "tg-plain")).toMatchObject({ email: null, telegram: { username: null }, contactEmail: null });
    expect(admin.accounts.find((account) => account.id === "selected")).toMatchObject({ email: "selected@example.test", telegram: null, contactEmail: null });
    expect(admin.hostRequests.find((request) => request.title === "Telegram meetup")).toMatchObject({ email: null, telegram: { username: "tg_handle" } });
    const reviews = await getBuilderProjectReviews();
    expect(reviews.projects.find((project) => project.id === TG_PROJECT)).toMatchObject({ ownerName: "Telegram Builder", owner: { email: null, telegram: { username: "tg_handle" } } });
    expect(reviews.projects.find((project) => project.id === PROJECT)).toMatchObject({ owner: { email: "selected@example.test", telegram: null } });
    expect(reviews.importRequests.find((request) => request.name === "Handle-less Builder")).toMatchObject({ email: null, telegram: { username: null } });
    expect(JSON.stringify([admin, reviews])).not.toContain("placeholder.invalid");
    // A profile row that somehow holds the placeholder still never reaches a page.
    await rows("UPDATE hq_builder_profiles SET email=$1, contact_email=$1 WHERE id='tg-only'", [PLACEHOLDER]);
    expect((await getBuilderAdminData()).accounts.find((account) => account.id === "tg-only")).toMatchObject({ email: null, contactEmail: null, telegram: { username: "tg_handle" } });
    expect(JSON.stringify([await getBuilderAdminData(), await getBuilderProjectReviews()])).not.toContain("placeholder.invalid");
  });

  it("renders a Telegram-only account as its handle, the contact email labelled apart, and an email account as before", async () => {
    const admin = await getBuilderAdminData();
    const reviews = await getBuilderProjectReviews();
    const html = renderToStaticMarkup(createElement(BuilderAdmin, { ...admin, hostRequests: admin.hostRequests }))
      + renderToStaticMarkup(createElement(BuilderProjectReviews, reviews));
    expect(html).toContain("Telegram: @tg_handle");
    expect(html).toContain("Contact email: reach-me@example.test");
    expect(html).toContain("Telegram account");
    expect(html).toContain("selected@example.test");
    expect(html).toContain("Initialized by Telegram Builder (Telegram: @tg_handle).");
    expect(html).toContain("Telegram Builder (Telegram: @tg_handle)");
    expect(html).not.toContain("placeholder.invalid");
    expect(html).not.toContain("()");
    expect(html).not.toContain("(null)");
    expect(html).not.toContain("Contact email: reach-me@example.test</p><p>Contact email");
    // The contact email line appears only for the account that declared one.
    expect(html.match(/Contact email:/g)).toHaveLength(1);
  });
});

describe("People tags, Captain grants and person-match correction", () => {
  const grants = () => rows("SELECT user_id,capability,granted_by_user_id::text AS granted_by,revoked_by_user_id::text AS revoked_by,revoked_at IS NULL AS active,reason FROM hq_account_capabilities ORDER BY granted_at,id");
  const events = () => rows("SELECT kind,actor_kind,actor_id,subject_user_id,metadata FROM hq_audit_events ORDER BY id");
  async function partnerCaptainRole() {
    const [role] = await rows(`INSERT INTO hq_people_roles(label,filter_label,color,bg,is_judge,sort)
      VALUES('Partner captain','Partner captains','accent','accent-fill',false,0) RETURNING id::text AS id`);
    return String(role.id);
  }
  async function selectedCard() {
    const [card] = await rows("SELECT id::text AS id FROM hq_people WHERE builder_user_id='selected'");
    return String(card.id);
  }

  it("shows a role tag on every card and a locked Captain tag only from an active grant, read in one batched query", async () => {
    await rows("INSERT INTO hq_builder_profiles(id,email,name) VALUES('second','second@example.test','Second Builder')");
    await rows("INSERT INTO hq_people(hackathon_id,builder_user_id,name,role_id) SELECT 11,'second','Second Builder',id FROM hq_people_roles");
    await rows("INSERT INTO hq_people(hackathon_id,name,role_id) SELECT 11,'Hand Entered',id FROM hq_people_roles");
    await grantCapability(builderDb, { actor: { kind: "operator", id: OPERATOR }, byOperatorId: OPERATOR, userId: "selected", capability: "captain", reason: "Leads the cohort" });
    queryCalls = 0;
    const people = (await getPeople(11)).sort((a, b) => a.name.localeCompare(b.name));
    expect(queryCalls).toBe(1);
    expect(people.map((p) => [p.name, p.builderUserId, p.tags])).toEqual([
      ["Hand Entered", null, [{ kind: "role", label: "Builder", protected: false }]],
      ["Second Builder", "second", [{ kind: "role", label: "Builder", protected: false }]],
      ["Selected Builder", "selected", [{ kind: "role", label: "Builder", protected: false }, { kind: "capability", label: "Captain", protected: true }]],
    ]);
    expect(people.find((p) => p.name === "Selected Builder")).toMatchObject({ personId: null, roleId: expect.any(String) });
    // The Admin account list reads the same grant, and the other edition's account holds nothing.
    const admin = await getBuilderAdminData();
    expect(admin.accounts.map((a) => [a.id, a.captain])).toEqual(expect.arrayContaining([["selected", true], ["second", false]]));
    expect(admin.captains).toEqual([expect.objectContaining({ userId: "selected", name: "Selected Builder", reason: "Leads the cohort" })]);
    expect((await getPeople(12)).map((p) => p.tags)).toEqual([[{ kind: "role", label: "Builder", protected: false }]]);
  });

  it("grants and revokes Captain from Admin with the operator recorded, visible on the next read", async () => {
    expect(await grantCaptainCapability("selected", "Leads the cohort")).toEqual({ ok: true });
    expect(await grants()).toEqual([{ user_id: "selected", capability: "captain", granted_by: OPERATOR, revoked_by: null, active: true, reason: "Leads the cohort" }]);
    expect((await getPeople(11))[0].tags).toContainEqual({ kind: "capability", label: "Captain", protected: true });
    expect(await grantCaptainCapability("selected", "Leads the cohort again")).toEqual({ ok: true });
    expect(await grants()).toHaveLength(1);
    expect(await revokeCaptainCapability("selected", "Stepped down")).toEqual({ ok: true });
    expect(await grants()).toEqual([expect.objectContaining({ active: false, revoked_by: OPERATOR })]);
    expect((await getPeople(11))[0].tags).toEqual([{ kind: "role", label: "Builder", protected: false }]);
    expect((await getBuilderAdminData()).accounts[0].captain).toBe(false);
    expect(await events()).toEqual([
      expect.objectContaining({ kind: "capability.granted", actor_kind: "operator", actor_id: OPERATOR, subject_user_id: "selected" }),
      expect.objectContaining({ kind: "capability.revoked", actor_kind: "operator", actor_id: OPERATOR, subject_user_id: "selected", metadata: expect.objectContaining({ reason: "Stepped down" }) }),
    ]);
    expect(mocks.refreshHq).toHaveBeenCalledTimes(3);
  });

  it("refuses a missing reason, an unknown account and a revocation without a grant, writing nothing", async () => {
    expect(await grantCaptainCapability("selected", "  ")).toMatchObject({ ok: false });
    expect(await grantCaptainCapability("nobody", "Leads the cohort")).toMatchObject({ ok: false, error: expect.stringContaining("account") });
    expect(await revokeCaptainCapability("selected", "Stepped down")).toMatchObject({ ok: false, error: expect.stringContaining("Captain") });
    expect(await grants()).toEqual([]);
    expect(await events()).toEqual([]);
    expect(mocks.refreshHq).not.toHaveBeenCalled();
  });

  it("never turns a People role edit, a new person or a tier change into a Captain grant", async () => {
    const roleId = await partnerCaptainRole();
    const card = await selectedCard();
    expect(await updatePerson(card, { field: "roleId", value: roleId })).toEqual({ ok: true });
    expect(await createPerson({ name: "Liaison Two", roleId, org: "Partner org", contact: "", partnerId: null, notes: "" })).toEqual({ ok: true });
    expect(await updateBuilderTier("selected", "member")).toEqual({ ok: true });
    expect(await grants()).toEqual([]);
    expect(await events()).toEqual([]);
    const people = (await getPeople(11)).sort((a, b) => a.name.localeCompare(b.name));
    expect(people.map((p) => [p.name, p.tags])).toEqual([
      ["Liaison Two", [{ kind: "role", label: "Partner captain", protected: false }]],
      ["Selected Builder", [{ kind: "role", label: "Partner captain", protected: false }]],
    ]);
    expect(people.every((p) => p.tags.every((tag) => !tag.protected))).toBe(true);
    expect((await getBuilderAdminData()).accounts[0]).toMatchObject({ tier: "member", captain: false });
  });

  it("keeps the renamed Partner captain role an ordinary, editable role beside the Captain capability", async () => {
    const roleId = await partnerCaptainRole();
    const card = await selectedCard();
    await grantCaptainCapability("selected", "Leads the cohort");
    expect(await updatePerson(card, { field: "roleId", value: roleId })).toEqual({ ok: true });
    expect((await getPeople(11))[0].tags).toEqual([
      { kind: "role", label: "Partner captain", protected: false },
      { kind: "capability", label: "Captain", protected: true },
    ]);
    const [builder] = await rows("SELECT id::text AS id FROM hq_people_roles WHERE label='Builder'");
    expect(await updatePerson(card, { field: "roleId", value: String(builder.id) })).toEqual({ ok: true });
    expect((await getPeople(11))[0].tags[0]).toEqual({ kind: "role", label: "Builder", protected: false });
    expect(await grants()).toHaveLength(1);
  });

  it("clears a wrong person match on the operator's say-so, with the operator on the event", async () => {
    const [person] = await rows("INSERT INTO hq_crm_persons(display_name,normalized_colosseum_username,builder_user_id) VALUES('Selected Builder','roster_handle','selected') RETURNING id::text AS id");
    await rows("UPDATE hq_people SET person_id=$1 WHERE builder_user_id='selected'", [person.id]);
    expect((await getPeople(11))[0]).toMatchObject({ builderUserId: "selected", personId: person.id });
    expect(await correctPersonMatch({ personId: String(person.id), toUserId: null, reason: "x" })).toMatchObject({ ok: false });
    expect(await correctPersonMatch({ personId: PROJECT, toUserId: null, reason: "Not this person" })).toMatchObject({ ok: false, error: expect.stringContaining("person") });
    expect(await correctPersonMatch({ personId: String(person.id), toUserId: null, reason: "Not this person" })).toEqual({ ok: true });
    expect(await rows("SELECT builder_user_id,normalized_colosseum_username FROM hq_crm_persons WHERE id=$1", [person.id])).toEqual([{ builder_user_id: null, normalized_colosseum_username: "roster_handle" }]);
    const [after] = await getPeople(11);
    expect(after.personId).not.toBeNull();
    expect(after.personId).not.toBe(person.id);
    expect(await rows("SELECT builder_user_id FROM hq_crm_persons WHERE id=$1", [after.personId])).toEqual([{ builder_user_id: "selected" }]);
    expect(await correctPersonMatch({ personId: String(person.id), toUserId: null, reason: "Not this person" })).toMatchObject({ ok: false });
    expect(await events()).toEqual([expect.objectContaining({
      kind: "person.match_corrected", actor_kind: "operator", actor_id: OPERATOR, subject_user_id: "selected",
      metadata: expect.objectContaining({ fromUserId: "selected", toUserId: null, reason: "Not this person" }),
    })]);
    expect(await grants()).toEqual([]);
    expect(mocks.refreshHq).toHaveBeenCalledTimes(1);
  });
});
