import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColosseumFetch, ImportedProject } from "@/lib/colosseum-api";
import { BuilderStore } from "@/lib/hq/builder-store";
import type { BuilderDatabase } from "@/lib/hq/builder-db";
import * as builderModule from "@/lib/hq/builder-store";
import * as identityModule from "@/lib/hq/identity";
import type { BuilderIdentity } from "@/lib/hq/builder-types";
import { grantCapability } from "@/lib/hq/capabilities";
import { assignCaptain } from "@/lib/hq/captains";
import { correctPersonMatch, ensurePersonForRosterMember, linkPersonToAccount, normalizeColosseumUsername } from "@/lib/hq/crm-identity";
import { deleteTeamRecord } from "@/lib/hq/record-deletion";
import { applyUpgrades } from "@/scripts/hq/upgrades";
import { pgliteBuilderDatabase } from "./helpers/db";

vi.mock("server-only", () => ({}));
const actionMocks = vi.hoisted(() => ({ requireMember: vi.fn() }));
vi.mock("@/lib/hq/member-auth", () => ({ requireMember: actionMocks.requireMember }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { acceptBuilderInvite, importBuilderTeam, requestBuilderReview } from "@/lib/hq/actions/builders";
import { joinLink, parseJoinCode } from "@/lib/hq/member-routes";
import { gateProject, previewColosseumTeam, previewTeamInvitation } from "@/lib/hq/project-import";

const OWNER: BuilderIdentity = { id: "auth-owner", email: "owner@example.test", name: "Owner" };
const TEAMMATE: BuilderIdentity = { id: "auth-teammate", email: "teammate@example.test", name: "Teammate" };
const OUTSIDER: BuilderIdentity = { id: "auth-outsider", email: "outsider@example.test", name: "Outsider" };
// Fictional project and roster, mirroring the structural fixture at
// tests/hq/fixtures/colosseum/detail.json.
const PROJECT: ImportedProject = {
  externalId: 90001,
  slug: "tulip-ledger",
  name: "Tulip Ledger",
  country: "Netherlands",
  category: "Payments & Remittance",
  tracks: [],
  twitterHandle: "tulipledger",
  submittedAt: "2026-05-11T20:00:00.000Z",
  completion: { isComplete: true, missingFieldCount: 0 },
  hackathon: { id: 6, slug: "frontier", name: "Frontier" },
  members: [
    { username: "fictional_builder_1", displayName: "Fictional Builder One", avatarUrl: null },
    { username: "fictional_builder_2", displayName: "Fictional Builder Two", avatarUrl: "https://static.example.test/two.png" },
  ],
  description: "An imported project description.",
  links: { repoLink: "https://github.com/example/project", website: null, presentationLink: null,
    technicalDemoLink: null, pitchVideoLink: null, demoVideoLink: null },
  imageUrl: null,
  raw: { projectType: "HACKATHON", project: { id: 90001, hackathonId: 6, slug: "tulip-ledger" } },
};
const PROJECT_URL = `https://colosseum.com/arena/projects/explore/${PROJECT.slug}`;

function projectResponse(project = PROJECT) {
  return new Response(JSON.stringify({ projectType: "HACKATHON", project: {
    id: project.externalId, slug: project.slug, name: project.name, country: project.country,
    hackathonId: project.hackathon.id, hackathon: project.hackathon, description: project.description,
    submittedAt: project.submittedAt, teamMembers: project.members,
  } }), { headers: { "Content-Type": "application/json" } });
}

let pg: PGlite;
let db: BuilderDatabase;
let store: BuilderStore;

async function rows(text: string, values?: unknown[]) { return (await db.query(text, values)).rows; }

async function ownTeam(userId: string, projectId: string) {
  const team = (await store.teams(userId)).find(team => team.id === projectId);
  if (!team) throw new Error("This team is not available to your account.");
  return team;
}

async function prepareUsers() {
  await Promise.all([OWNER, TEAMMATE, OUTSIDER].map(user => store.syncAccount(user)));
}

/** One self-service import: no challenge, no proof, no approval — the whole flow is this call. */
async function importProject(project = PROJECT, owner = OWNER, hackathonId = 41, selectedUsername = project.members[0].username) {
  return store.importTeam(owner, { selectedUsername, hackathonId, project, projectUrl: `https://colosseum.com/arena/projects/explore/${project.slug}` });
}

/** Exercise enrollment through a production caller, not a separate store API. */
async function importInEdition(user: BuilderIdentity, hackathonId: number, externalId = PROJECT.externalId) {
  return importProject({ ...PROJECT, externalId,
    hackathon: { ...PROJECT.hackathon, id: hackathonId === 42 ? 7 : 6 },
  }, user, hackathonId);
}

async function invite() {
  const id = await importProject();
  const team = await ownTeam(OWNER.id, id);
  const member = team.members.find(item => item.username === "fictional_builder_2")!;
  return { projectId: id, memberId: member.id, code: await store.createInvite(OWNER.id, id) };
}

beforeAll(async () => {
  pg = new PGlite();
  db = pgliteBuilderDatabase(pg);
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
  it("reads unchanged accounts without opening a write transaction, and repairs missing CRM identity", async () => {
    let transactions = 0;
    const observed: BuilderDatabase = { query: vi.fn(db.query), transaction: work => { transactions += 1; return db.transaction(work); } };
    const observedStore = new BuilderStore(observed);
    await observedStore.syncAccount(OWNER);
    expect(observed.query).toHaveBeenCalledTimes(1);
    expect(transactions).toBe(0);
    await db.query("DELETE FROM hq_crm_persons WHERE builder_user_id=$1", [OWNER.id]);
    await observedStore.syncAccount(OWNER);
    expect(transactions).toBe(1);
    expect(await rows("SELECT count(*)::int AS n FROM hq_crm_persons WHERE builder_user_id=$1", [OWNER.id])).toEqual([{ n: 1 }]);
  });

  it("applies the additive schema repeatedly", async () => {
    await expect(pg.exec(readFileSync(join(process.cwd(), "scripts/hq/builder-schema.sql"), "utf8"))).resolves.toBeDefined();
  });

  it("creates one Builder card per authenticated account and selected edition", async () => {
    await Promise.all(Array.from({ length: 4 }, () => store.syncAccount(OWNER)));
    await Promise.all(Array.from({ length: 3 }, (_, i) => importInEdition(OWNER, 42, PROJECT.externalId + i)));
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
    await db.query(`INSERT INTO hq_people_roles(label,filter_label,color,bg,is_judge,sort)
      VALUES('Community','Community','accent','accent-fill',false,100) ON CONFLICT(label) DO NOTHING`);
    await db.query("UPDATE hq_builder_enrollments SET participation='supporter' WHERE user_id=$1", [OWNER.id]);
    await db.query("UPDATE hq_people SET role_id=(SELECT id FROM hq_people_roles WHERE label='Community') WHERE builder_user_id=$1", [OWNER.id]);
    await db.query("UPDATE hq_people SET notes='Spoke at our event',contact='@owner' WHERE builder_user_id=$1", [OWNER.id]);
    await store.syncAccount({ ...OWNER, name: "Updated account name" });
    expect(await rows(`SELECT r.label,p.notes,p.contact FROM hq_people p JOIN hq_people_roles r ON r.id=p.role_id
      WHERE p.builder_user_id=$1`, [OWNER.id])).toEqual([{ label: "Community", notes: "Spoke at our event", contact: "@owner" }]);
    await importInEdition(OWNER, 41);
    expect(await rows(`SELECT r.label FROM hq_people p JOIN hq_people_roles r ON r.id=p.role_id WHERE p.builder_user_id=$1`, [OWNER.id]))
      .toEqual([{ label: "Builder" }]);
  });

  it("enrolls without tripping the per-edition person index when another card already carries the account's person", async () => {
    const [{ id: own }] = await rows("SELECT id FROM hq_crm_persons WHERE builder_user_id=$1", [OWNER.id]);
    // Edition 41: the account's card is unstamped while a roster card carries
    // its person, the state a person-match link can leave behind. Edition
    // 42: no card for the account yet, a roster card already carries it.
    await db.query("UPDATE hq_people SET person_id=NULL WHERE builder_user_id=$1 AND hackathon_id=41", [OWNER.id]);
    for (const edition of [41, 42]) {
      await db.query(`INSERT INTO hq_people(hackathon_id,name,role_id,person_id) SELECT $1,'Owner (roster card)',id,$2 FROM hq_people_roles WHERE label='Builder'`, [edition, own]);
    }
    await expect(importInEdition(OWNER, 41)).resolves.toEqual(expect.any(String));
    await expect(importInEdition(OWNER, 42)).resolves.toEqual(expect.any(String));
    expect(await rows(`SELECT p.hackathon_id,p.person_id,r.label FROM hq_people p JOIN hq_people_roles r ON r.id=p.role_id
      WHERE p.builder_user_id=$1 ORDER BY p.hackathon_id`, [OWNER.id])).toEqual([
      { hackathon_id: 41, person_id: null, label: "Builder" },
      { hackathon_id: 42, person_id: null, label: "Builder" },
    ]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_people WHERE person_id=$1", [own])).toEqual([{ n: 2 }]);
    // Once the other card is gone, the next enrolment stamps the account's card as before.
    await db.query("DELETE FROM hq_people WHERE person_id=$1 AND builder_user_id IS NULL AND hackathon_id=41", [own]);
    await importInEdition(OWNER, 41, PROJECT.externalId + 1);
    expect(await rows("SELECT person_id FROM hq_people WHERE builder_user_id=$1 AND hackathon_id=41", [OWNER.id])).toEqual([{ person_id: own }]);
  });

  it("rejects unavailable editions without leaving a People card or enrollment", async () => {
    await expect(importInEdition(OWNER, 43)).rejects.toMatchObject({ reason: "edition_not_configured" });
    await expect(importInEdition(OWNER, 999)).rejects.toMatchObject({ reason: "edition_not_configured" });
    expect(await rows("SELECT hackathon_id FROM hq_builder_enrollments WHERE user_id=$1", [OWNER.id])).toEqual([{ hackathon_id: 41 }]);
    expect((await store.hackathons()).map(item => item.id)).toEqual([41, 42]);
  });
});

describe("accounts without an email, contact email and CRM person identity", () => {
  const TELEGRAM_ONLY: BuilderIdentity = { id: "auth-telegram", email: null, name: "Telegram Builder" };
  const PLACEHOLDER = "1234123412341234123@telegram.placeholder.invalid";

  async function person(userId: string) {
    const [row] = await rows("SELECT id,display_name,normalized_colosseum_username FROM hq_crm_persons WHERE builder_user_id=$1", [userId]);
    return row as { id: string; display_name: string; normalized_colosseum_username: string | null } | undefined;
  }

  it("syncs a Telegram-only account with no email, a People card without a contact, and its person", async () => {
    await store.syncAccount(TELEGRAM_ONLY);
    await store.syncAccount(TELEGRAM_ONLY);
    expect(await rows("SELECT email,contact_email,name FROM hq_builder_profiles WHERE id=$1", [TELEGRAM_ONLY.id]))
      .toEqual([{ email: null, contact_email: null, name: "Telegram Builder" }]);
    const linked = await person(TELEGRAM_ONLY.id);
    expect(linked).toMatchObject({ display_name: "Telegram Builder", normalized_colosseum_username: null });
    expect(await rows(`SELECT p.hackathon_id,p.name,p.contact,p.person_id,r.label FROM hq_people p
      JOIN hq_people_roles r ON r.id=p.role_id WHERE p.builder_user_id=$1`, [TELEGRAM_ONLY.id]))
      .toEqual([{ hackathon_id: 41, name: "Telegram Builder", contact: "", person_id: linked!.id, label: "Builder" }]);
    expect(await store.profile(TELEGRAM_ONLY.id)).toEqual({ id: TELEGRAM_ONLY.id, email: null, contactEmail: null, name: "Telegram Builder" });
    expect(await rows("SELECT count(*)::int AS n FROM hq_crm_persons WHERE builder_user_id=$1", [TELEGRAM_ONLY.id])).toEqual([{ n: 1 }]);
  });

  it("never writes the placeholder address to a profile, a contact or a People card", async () => {
    await store.syncAccount({ ...TELEGRAM_ONLY, email: PLACEHOLDER });
    await importInEdition({ ...TELEGRAM_ONLY, email: PLACEHOLDER }, 42);
    expect(await rows("SELECT email,contact_email FROM hq_builder_profiles WHERE id=$1", [TELEGRAM_ONLY.id])).toEqual([{ email: null, contact_email: null }]);
    expect(await rows("SELECT contact FROM hq_people WHERE builder_user_id=$1 ORDER BY hackathon_id", [TELEGRAM_ONLY.id])).toEqual([{ contact: "" }, { contact: "" }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_builder_profiles WHERE email ILIKE '%placeholder.invalid' OR contact_email ILIKE '%placeholder.invalid'")).toEqual([{ n: 0 }]);
    await db.query("UPDATE hq_builder_profiles SET contact_email=$1 WHERE id=$2", [PLACEHOLDER, TELEGRAM_ONLY.id]);
    expect((await store.profile(TELEGRAM_ONLY.id))?.contactEmail).toBeNull();
  });

  it("keeps the self-declared contact email apart from the login email", async () => {
    await db.query("UPDATE hq_builder_profiles SET contact_email='hello@example.test' WHERE id=$1", [OWNER.id]);
    // The login address changes, and then goes away: the contact stays, and is never filled from the login.
    await store.syncAccount({ ...OWNER, email: "owner-moved@example.test" });
    expect(await store.profile(OWNER.id)).toEqual({ id: OWNER.id, email: "owner-moved@example.test", contactEmail: "hello@example.test", name: "Owner" });
    await store.syncAccount({ ...OWNER, email: null });
    expect(await store.profile(OWNER.id)).toEqual({ id: OWNER.id, email: null, contactEmail: "hello@example.test", name: "Owner" });
    await store.syncAccount(TEAMMATE);
    expect((await store.profile(TEAMMATE.id))?.contactEmail).toBeNull();
    expect(await store.profile("never-synced")).toBeNull();
  });

  it("gives every synced account exactly one person and stamps it on each edition's card", async () => {
    await Promise.all(Array.from({ length: 3 }, () => store.syncAccount(OWNER)));
    await importInEdition(OWNER, 42);
    const owner = await person(OWNER.id);
    expect(await rows("SELECT hackathon_id,person_id FROM hq_people WHERE builder_user_id=$1 ORDER BY hackathon_id", [OWNER.id]))
      .toEqual([{ hackathon_id: 41, person_id: owner!.id }, { hackathon_id: 42, person_id: owner!.id }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_crm_persons")).toEqual([{ n: 3 }]);
  });

  it("normalizes a Colosseum username and treats nothing else as one", () => {
    expect(normalizeColosseumUsername("  @Fictional_Builder_2 ")).toBe("fictional_builder_2");
    expect(normalizeColosseumUsername("@@Handle")).toBe("handle");
    expect(normalizeColosseumUsername("@ ")).toBeNull();
    expect(normalizeColosseumUsername("")).toBeNull();
    expect(normalizeColosseumUsername(null)).toBeNull();
    expect(normalizeColosseumUsername(undefined)).toBeNull();
  });

  it("reuses a roster person for the same normalized username, never for the same display name", async () => {
    const first = await ensurePersonForRosterMember(db, { colosseumUsername: "@Fictional_Builder_2", displayName: "Fictional Builder Two" });
    const again = await ensurePersonForRosterMember(db, { colosseumUsername: "fictional_builder_2 ", displayName: "Renamed On Colosseum" });
    const namesake = await ensurePersonForRosterMember(db, { colosseumUsername: "another_handle", displayName: "Fictional Builder Two" });
    expect(again).toBe(first);
    expect(namesake).not.toBe(first);
    expect(await rows("SELECT display_name,normalized_colosseum_username,builder_user_id FROM hq_crm_persons WHERE normalized_colosseum_username IS NOT NULL ORDER BY normalized_colosseum_username"))
      .toEqual([
        { display_name: "Fictional Builder Two", normalized_colosseum_username: "another_handle", builder_user_id: null },
        { display_name: "Fictional Builder Two", normalized_colosseum_username: "fictional_builder_2", builder_user_id: null },
      ]);
    await expect(ensurePersonForRosterMember(db, { colosseumUsername: " @ ", displayName: "Fictional Builder Two" })).rejects.toThrow("username");
    // Two accounts named alike stay two people as well.
    await store.syncAccount({ id: "auth-namesake", email: null, name: OWNER.name });
    expect(await rows("SELECT count(*)::int AS n FROM hq_crm_persons WHERE display_name=$1", [OWNER.name])).toEqual([{ n: 2 }]);
  });

  it("links a roster person to an account and stamps the account's cards, both or neither", async () => {
    // An account whose card predates person identity: no person row, no stamp.
    await db.query("INSERT INTO hq_builder_profiles(id,email,name) VALUES('auth-legacy',NULL,'Legacy Builder')");
    await db.query(`INSERT INTO hq_people(hackathon_id,builder_user_id,name,role_id)
      SELECT 41,'auth-legacy','Legacy Builder',id FROM hq_people_roles WHERE label='Builder'`);
    const roster = await ensurePersonForRosterMember(db, { colosseumUsername: "legacy_handle", displayName: "Legacy Builder" });

    await db.query("ALTER TABLE hq_crm_persons ADD CONSTRAINT test_link_failure CHECK (builder_user_id IS DISTINCT FROM 'auth-legacy')");
    try {
      await expect(linkPersonToAccount(db, { personId: roster, userId: "auth-legacy" })).rejects.toThrow();
    } finally { await db.query("ALTER TABLE hq_crm_persons DROP CONSTRAINT test_link_failure"); }
    expect(await rows("SELECT person_id FROM hq_people WHERE builder_user_id='auth-legacy'")).toEqual([{ person_id: null }]);
    expect(await rows("SELECT builder_user_id FROM hq_crm_persons WHERE id=$1", [roster])).toEqual([{ builder_user_id: null }]);

    await linkPersonToAccount(db, { personId: roster, userId: "auth-legacy" });
    expect(await rows("SELECT person_id FROM hq_people WHERE builder_user_id='auth-legacy'")).toEqual([{ person_id: roster }]);
    expect(await rows("SELECT builder_user_id,updated_at > created_at AS touched FROM hq_crm_persons WHERE id=$1", [roster])).toEqual([{ builder_user_id: "auth-legacy", touched: true }]);
    // Linking the same pair again is a no-op, and so is a later sync: the link is not re-pointed to a fresh person.
    await linkPersonToAccount(db, { personId: roster, userId: "auth-legacy" });
    await store.syncAccount({ id: "auth-legacy", email: null, name: "Legacy Builder" });
    expect(await rows("SELECT count(*)::int AS n FROM hq_crm_persons WHERE builder_user_id='auth-legacy'")).toEqual([{ n: 1 }]);
    expect(await rows("SELECT person_id FROM hq_people WHERE builder_user_id='auth-legacy'")).toEqual([{ person_id: roster }]);
  });

  it("refuses to re-point a link in either direction", async () => {
    const owner = (await person(OWNER.id))!;
    const roster = await ensurePersonForRosterMember(db, { colosseumUsername: "fictional_builder_2", displayName: "Fictional Builder Two" });
    await expect(linkPersonToAccount(db, { personId: owner.id, userId: TEAMMATE.id })).rejects.toThrow("another account");
    await expect(linkPersonToAccount(db, { personId: roster, userId: OWNER.id })).rejects.toThrow("another person");
    await expect(linkPersonToAccount(db, { personId: roster, userId: "no-such-account" })).rejects.toThrow("account");
    await expect(linkPersonToAccount(db, { personId: "00000000-0000-4000-8000-000000000009", userId: OWNER.id })).rejects.toThrow("person");
    expect(await rows("SELECT builder_user_id FROM hq_crm_persons WHERE id=$1", [roster])).toEqual([{ builder_user_id: null }]);
    expect(await rows("SELECT builder_user_id FROM hq_crm_persons WHERE id=$1", [owner.id])).toEqual([{ builder_user_id: OWNER.id }]);
  });
});

describe("correcting a person match", () => {
  const OPERATOR_ACTOR = { kind: "operator" as const, id: "00000000-0000-4000-8000-000000000001" };
  const personOf = async (userId: string) => rows("SELECT id,normalized_colosseum_username FROM hq_crm_persons WHERE builder_user_id=$1", [userId]) as Promise<{ id: string; normalized_colosseum_username: string | null }[]>;
  const card = async (userId: string, hackathonId: number) =>
    (await rows("SELECT id::text AS id,person_id FROM hq_people WHERE builder_user_id=$1 AND hackathon_id=$2", [userId, hackathonId]))[0] as { id: string; person_id: string | null };
  const events = () => rows("SELECT kind,actor_kind,actor_id,subject_user_id,metadata FROM hq_audit_events ORDER BY id");
  const rosterCard = async (hackathonId: number, personId: string) => String((await rows(
    `INSERT INTO hq_people(hackathon_id,name,role_id,person_id) SELECT $1,'Fictional Builder One',id,$2 FROM hq_people_roles WHERE label='Builder' RETURNING id::text AS id`,
    [hackathonId, personId]))[0].id);

  it("clears a wrong link: the account gets a person of its own and the roster person keeps its identity", async () => {
    const [{ id: wrong }] = await personOf(OWNER.id);
    await db.query("UPDATE hq_crm_persons SET normalized_colosseum_username='not_the_owner' WHERE id=$1", [wrong]);
    expect((await card(OWNER.id, 41)).person_id).toBe(wrong);
    const result = await correctPersonMatch(db, { personId: wrong, toUserId: null, reason: "Different person on the roster", actor: OPERATOR_ACTOR });
    const [fresh] = await personOf(OWNER.id);
    expect(fresh.id).not.toBe(wrong);
    // The person keeps its provisional key, so it stays for a later explicit link.
    expect(result).toMatchObject({ changed: true, fromUserId: OWNER.id, toUserId: null, survivingPersonId: wrong, mergedPersonId: null, replacementPersonId: fresh.id, deletedPersonId: null, movedCards: [], unlinkedCards: [], movedRosterRows: 0 });
    expect(await rows("SELECT builder_user_id,normalized_colosseum_username FROM hq_crm_persons WHERE id=$1", [wrong]))
      .toEqual([{ builder_user_id: null, normalized_colosseum_username: "not_the_owner" }]);
    expect((await card(OWNER.id, 41)).person_id).toBe(fresh.id);
    expect(await events()).toEqual([{
      kind: "person.match_corrected", actor_kind: "operator", actor_id: OPERATOR_ACTOR.id, subject_user_id: OWNER.id,
      metadata: { fromUserId: OWNER.id, toUserId: null, reason: "Different person on the roster", fromPersonId: wrong, toPersonId: wrong, replacementPersonId: fresh.id, deletedPersonId: null, movedCards: [], unlinkedCards: [], movedRosterRows: 0 },
    }]);
    // A later sync keeps the fresh person; the roster person is never re-linked by name.
    await store.syncAccount(OWNER);
    expect(await personOf(OWNER.id)).toEqual([expect.objectContaining({ id: fresh.id })]);
    expect(await correctPersonMatch(db, { personId: wrong, toUserId: null, reason: "again", actor: OPERATOR_ACTOR })).toMatchObject({ changed: false });
    expect(await events()).toHaveLength(1);
  });

  it("removes a cleared person that nothing identifies any more, instead of orphaning it", async () => {
    // The account's own auto-created person: no provisional key, no other card, no roster row.
    const [{ id: own }] = await personOf(OWNER.id);
    const result = await correctPersonMatch(db, { personId: own, toUserId: null, reason: "Clicked in error, nothing to detach", actor: OPERATOR_ACTOR });
    const [fresh] = await personOf(OWNER.id);
    expect(fresh.id).not.toBe(own);
    expect(result).toMatchObject({ changed: true, fromUserId: OWNER.id, toUserId: null, replacementPersonId: fresh.id, deletedPersonId: own });
    expect(await rows("SELECT count(*)::int AS n FROM hq_crm_persons WHERE id=$1", [own])).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_crm_persons")).toEqual([{ n: 3 }]);
    expect((await card(OWNER.id, 41)).person_id).toBe(fresh.id);
    expect((await events())[0]).toMatchObject({ subject_user_id: OWNER.id, metadata: expect.objectContaining({ fromPersonId: own, deletedPersonId: own, replacementPersonId: fresh.id }) });
    // A second click on the same card can only name a person that is gone.
    await expect(correctPersonMatch(db, { personId: own, toUserId: null, reason: "again", actor: OPERATOR_ACTOR })).rejects.toThrow("no longer in the CRM");
    expect(await events()).toHaveLength(1);
    expect(await rows("SELECT count(*)::int AS n FROM hq_crm_persons")).toEqual([{ n: 3 }]);
  });

  it("keeps a cleared person that a roster row or another card still names", async () => {
    const [{ id: own }] = await personOf(OWNER.id);
    await importProject();
    await db.query("UPDATE hq_project_members SET person_id=$1 WHERE colosseum_username='fictional_builder_1'", [own]);
    const viaRoster = await correctPersonMatch(db, { personId: own, toUserId: null, reason: "Roster row names it", actor: OPERATOR_ACTOR });
    expect(viaRoster).toMatchObject({ deletedPersonId: null });
    expect(await rows("SELECT builder_user_id FROM hq_crm_persons WHERE id=$1", [own])).toEqual([{ builder_user_id: null }]);
    // And a person that another edition's card names is kept as well.
    const [{ id: teammatePerson }] = await personOf(TEAMMATE.id);
    await rosterCard(42, teammatePerson);
    const viaCard = await correctPersonMatch(db, { personId: teammatePerson, toUserId: null, reason: "A card in 42 names it", actor: OPERATOR_ACTOR });
    expect(viaCard).toMatchObject({ deletedPersonId: null });
    expect(await rows("SELECT builder_user_id FROM hq_crm_persons WHERE id=$1", [teammatePerson])).toEqual([{ builder_user_id: null }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_people WHERE person_id=$1", [teammatePerson])).toEqual([{ n: 1 }]);
    // Three original people and two replacements from the explicit clears.
    expect(await rows("SELECT count(*)::int AS n FROM hq_crm_persons")).toEqual([{ n: 5 }]);
  });

  it("links a roster person to an account without a person, leaving a colliding card unstamped and reported", async () => {
    await db.query("INSERT INTO hq_builder_profiles(id,email,name) VALUES('auth-legacy',NULL,'Legacy Builder')");
    for (const edition of [41, 42]) {
      await db.query(`INSERT INTO hq_people(hackathon_id,builder_user_id,name,role_id) SELECT $1,'auth-legacy','Legacy Builder',id FROM hq_people_roles WHERE label='Builder'`, [edition]);
    }
    const roster = await ensurePersonForRosterMember(db, { colosseumUsername: "legacy_handle", displayName: "Legacy Builder" });
    const colliding = await rosterCard(41, roster);
    const result = await correctPersonMatch(db, { personId: roster, toUserId: "auth-legacy", reason: "Same person, confirmed by the team", actor: OPERATOR_ACTOR });
    const legacy41 = await card("auth-legacy", 41);
    expect(result).toMatchObject({ changed: true, fromUserId: null, toUserId: "auth-legacy", survivingPersonId: roster, mergedPersonId: null, movedCards: [], unlinkedCards: [legacy41.id] });
    expect(legacy41.person_id).toBeNull();
    expect((await card("auth-legacy", 42)).person_id).toBe(roster);
    expect(await rows("SELECT person_id FROM hq_people WHERE id=$1", [colliding])).toEqual([{ person_id: roster }]);
    expect(await rows("SELECT builder_user_id FROM hq_crm_persons WHERE builder_user_id='auth-legacy'")).toEqual([{ builder_user_id: "auth-legacy" }]);
    expect((await events())[0]).toMatchObject({ subject_user_id: "auth-legacy", metadata: expect.objectContaining({ fromPersonId: roster, toPersonId: roster, unlinkedCards: [legacy41.id] }) });
    // The member's next login sync must survive the state this leaves behind:
    // an unstamped card in 41 while the roster card there carries the person.
    await expect(importInEdition({ id: "auth-legacy", email: null, name: "Legacy Builder" }, 41)).resolves.toEqual(expect.any(String));
    expect((await card("auth-legacy", 41)).person_id).toBeNull();
    expect(await rows("SELECT count(*)::int AS n FROM hq_people WHERE hackathon_id=41 AND person_id=$1", [roster])).toEqual([{ n: 1 }]);
  });

  it("merges a roster person into the account's own person: cards and roster rows follow, a collision is reported, the username moves", async () => {
    const [{ id: own }] = await personOf(OWNER.id);
    const roster = await ensurePersonForRosterMember(db, { colosseumUsername: "fictional_builder_1", displayName: "Fictional Builder One" });
    const colliding = await rosterCard(41, roster);
    const moving = await rosterCard(42, roster);
    await importProject(PROJECT, OUTSIDER, 41, PROJECT.members[1].username);
    await db.query("UPDATE hq_project_members SET person_id=$1 WHERE colosseum_username='fictional_builder_1'", [roster]);
    const result = await correctPersonMatch(db, { personId: roster, toUserId: OWNER.id, reason: "Owner imported the team under this handle", actor: OPERATOR_ACTOR });
    expect(result).toMatchObject({ changed: true, fromUserId: null, toUserId: OWNER.id, survivingPersonId: own, mergedPersonId: roster, movedCards: [moving], unlinkedCards: [colliding], movedRosterRows: 1 });
    expect(await rows("SELECT count(*)::int AS n FROM hq_crm_persons WHERE id=$1", [roster])).toEqual([{ n: 0 }]);
    expect(await rows("SELECT builder_user_id,normalized_colosseum_username,display_name FROM hq_crm_persons WHERE id=$1", [own]))
      .toEqual([{ builder_user_id: OWNER.id, normalized_colosseum_username: "fictional_builder_1", display_name: "Owner" }]);
    expect((await card(OWNER.id, 41)).person_id).toBe(own);
    expect(await rows("SELECT person_id FROM hq_people WHERE id=$1", [colliding])).toEqual([{ person_id: null }]);
    expect(await rows("SELECT person_id FROM hq_people WHERE id=$1", [moving])).toEqual([{ person_id: own }]);
    expect(await rows("SELECT person_id FROM hq_project_members WHERE colosseum_username='fictional_builder_1'")).toEqual([{ person_id: own }]);
    // The provisional key now resolves to the account's person, and the merge is audited.
    expect(await ensurePersonForRosterMember(db, { colosseumUsername: "@Fictional_Builder_1", displayName: "Someone Else" })).toBe(own);
    // The import above writes its own project.imported event first; the
    // correction is the one under test.
    expect(await events()).toEqual([expect.objectContaining({ kind: "person.match_corrected" }), expect.objectContaining({ kind: "project.imported" }), expect.objectContaining({
      kind: "person.match_corrected", actor_id: OPERATOR_ACTOR.id, subject_user_id: OWNER.id,
      metadata: expect.objectContaining({ fromPersonId: roster, toPersonId: own, movedCards: [moving], unlinkedCards: [colliding], movedRosterRows: 1, mergedColosseumUsername: "fictional_builder_1" }),
    })]);
    // A survivor that already has a username keeps it.
    const other = await ensurePersonForRosterMember(db, { colosseumUsername: "second_handle", displayName: "Owner" });
    await correctPersonMatch(db, { personId: other, toUserId: OWNER.id, reason: "Also the owner", actor: OPERATOR_ACTOR });
    expect(await rows("SELECT normalized_colosseum_username FROM hq_crm_persons WHERE id=$1", [own])).toEqual([{ normalized_colosseum_username: "fictional_builder_1" }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_crm_persons WHERE display_name='Owner'")).toEqual([{ n: 1 }]);
  });

  it("re-points a person between accounts by id only, never by display name", async () => {
    const [{ id: teammatePerson }] = await personOf(TEAMMATE.id);
    const namesake = await ensurePersonForRosterMember(db, { colosseumUsername: "namesake_handle", displayName: TEAMMATE.name });
    await db.query("INSERT INTO hq_builder_profiles(id,email,name) VALUES('auth-new','new@example.test','New Builder')");
    const [{ id: outsiderPerson }] = await personOf(OUTSIDER.id);
    const result = await correctPersonMatch(db, { personId: outsiderPerson, toUserId: "auth-new", reason: "The outsider account belongs to the new builder", actor: OPERATOR_ACTOR });
    expect(result).toMatchObject({ changed: true, fromUserId: OUTSIDER.id, toUserId: "auth-new", survivingPersonId: outsiderPerson, mergedPersonId: null });
    expect(await rows("SELECT builder_user_id FROM hq_crm_persons WHERE id=$1", [outsiderPerson])).toEqual([{ builder_user_id: "auth-new" }]);
    const [fresh] = await personOf(OUTSIDER.id);
    expect(fresh.id).not.toBe(outsiderPerson);
    expect((await card(OUTSIDER.id, 41)).person_id).toBe(fresh.id);
    // The namesake pair is untouched: two people with one display name stay two.
    expect(await rows("SELECT builder_user_id FROM hq_crm_persons WHERE id=$1", [namesake])).toEqual([{ builder_user_id: null }]);
    expect(await personOf(TEAMMATE.id)).toEqual([expect.objectContaining({ id: teammatePerson })]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_crm_persons WHERE display_name=$1", [TEAMMATE.name])).toEqual([{ n: 2 }]);
  });

  it("refuses an unknown person or account, and rolls everything back when the audit write fails", async () => {
    const [{ id: own }] = await personOf(OWNER.id);
    await expect(correctPersonMatch(db, { personId: "00000000-0000-4000-8000-000000000009", toUserId: null, reason: "x", actor: OPERATOR_ACTOR })).rejects.toThrow("person");
    // The refusal comes after the detach step, so the detach must roll back with it.
    await expect(correctPersonMatch(db, { personId: own, toUserId: "no-such-account", reason: "x", actor: OPERATOR_ACTOR })).rejects.toThrow("account");
    expect(await rows("SELECT builder_user_id FROM hq_crm_persons WHERE id=$1", [own])).toEqual([{ builder_user_id: OWNER.id }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_crm_persons")).toEqual([{ n: 3 }]);
    await db.query("ALTER TABLE hq_audit_events ADD CONSTRAINT test_correction_failure CHECK (kind <> 'person.match_corrected')");
    try {
      await expect(correctPersonMatch(db, { personId: own, toUserId: null, reason: "x", actor: OPERATOR_ACTOR })).rejects.toThrow(/test_correction_failure/);
    } finally { await db.query("ALTER TABLE hq_audit_events DROP CONSTRAINT test_correction_failure"); }
    expect(await rows("SELECT builder_user_id FROM hq_crm_persons WHERE id=$1", [own])).toEqual([{ builder_user_id: OWNER.id }]);
    expect((await card(OWNER.id, 41)).person_id).toBe(own);
    expect(await rows("SELECT count(*)::int AS n FROM hq_crm_persons")).toEqual([{ n: 3 }]);
    expect(await events()).toEqual([]);
  });
});

describe("re-import after an admin deletes a project", () => {
  const operatorId = "00000000-0000-4000-8000-000000000001";

  beforeEach(async () => {
    await db.query(`INSERT INTO hq_users(id,username,display_name,password_hash)
      VALUES($1,'removal-operator','Operator','unused') ON CONFLICT(id) DO NOTHING`, [operatorId]);
  });

  it.each([OWNER, TEAMMATE, OUTSIDER])("lets $name import again and claim a previously occupied roster entry", async (user) => {
    const { projectId, memberId, code } = await invite();
    await store.redeemInvite(TEAMMATE, code, memberId);
    const people = await rows("SELECT id,builder_user_id,person_id FROM hq_people ORDER BY id");
    const accounts = await rows("SELECT id,email,name FROM hq_builder_profiles ORDER BY id");

    expect(await deleteTeamRecord(db, { projectId, hackathonId: 41, operatorId })).toMatchObject({ imported: true });
    expect(await store.importedProject(41, PROJECT.externalId)).toBeNull();
    expect(await store.invitation(code)).toMatchObject({ ok: false });

    const importedId = await importProject(PROJECT, user);
    expect(importedId).not.toBe(projectId);
    expect(await store.importedProject(41, PROJECT.externalId)).toEqual({ projectId: importedId });
    expect(await rows("SELECT owner_user_id FROM hq_project_ownership WHERE project_id=$1", [importedId]))
      .toEqual([{ owner_user_id: user.id }]);
    expect(await rows("SELECT builder_user_id FROM hq_project_members WHERE project_id=$1 ORDER BY sort", [importedId]))
      .toEqual([{ builder_user_id: user.id }, { builder_user_id: null }]);

    // The other formerly occupied seat is available to a different account too.
    const joining = user.id === OUTSIDER.id ? OWNER : OUTSIDER;
    const newTeam = await ownTeam(user.id, importedId);
    const secondSeat = newTeam.members.find(member => member.username === PROJECT.members[1].username)!;
    await store.redeemInvite(joining, await store.createInvite(user.id, importedId), secondSeat.id);
    expect(await store.joinedSeat(importedId, joining.id)).toBe(secondSeat.id);
    expect(await rows("SELECT id,builder_user_id,person_id FROM hq_people ORDER BY id")).toEqual(people);
    expect(await rows("SELECT id,email,name FROM hq_builder_profiles ORDER BY id")).toEqual(accounts);
    await expect(importProject(PROJECT, joining)).rejects.toMatchObject({ reason: "already_imported" });
  });

  it("preserves the previous account's memberships and People cards in other projects and editions", async () => {
    const projectId = await importProject();
    const otherProjectId = await importInEdition(OWNER, 42);
    const otherRoster = await rows("SELECT id,person_id,builder_user_id FROM hq_project_members WHERE project_id=$1 ORDER BY sort", [otherProjectId]);
    const people = await rows("SELECT id,builder_user_id,person_id FROM hq_people ORDER BY id");
    await deleteTeamRecord(db, { projectId, hackathonId: 41, operatorId });

    const importedId = await importProject(PROJECT, OUTSIDER);
    expect((await store.teams(OUTSIDER.id)).map(team => team.id)).toEqual([importedId]);
    expect((await store.teams(OWNER.id)).map(team => team.id)).toEqual([otherProjectId]);
    expect(await rows("SELECT id,person_id,builder_user_id FROM hq_project_members WHERE project_id=$1 ORDER BY sort", [otherProjectId])).toEqual(otherRoster);
    expect(await rows("SELECT id,builder_user_id,person_id FROM hq_people ORDER BY id")).toEqual(people);
  });

  it("keeps unrelated Colosseum identity matches", async () => {
    const otherProject = { ...PROJECT, externalId: 90002, slug: "other-team", members: [
      { username: "unrelated_builder", displayName: "Another Builder", avatarUrl: null },
    ] };
    await importProject(otherProject, OUTSIDER);
    const projectId = await importProject();
    await deleteTeamRecord(db, { projectId, hackathonId: 41, operatorId });
    expect(await rows("SELECT normalized_colosseum_username FROM hq_crm_persons WHERE builder_user_id=$1", [OUTSIDER.id]))
      .toEqual([{ normalized_colosseum_username: "unrelated_builder" }]);
    await expect(importProject(PROJECT, OUTSIDER)).resolves.toEqual(expect.any(String));
  });

  it("does not release the project or its roster identities when deletion is refused or rolls back", async () => {
    const projectId = await importProject();
    expect(await deleteTeamRecord(db, { projectId, hackathonId: 42, operatorId })).toBeNull();
    await db.query("ALTER TABLE hq_audit_events ADD CONSTRAINT test_deletion_failure CHECK (kind <> 'project.deleted')");
    try {
      await expect(deleteTeamRecord(db, { projectId, hackathonId: 41, operatorId })).rejects.toThrow(/test_deletion_failure/);
    } finally {
      await db.query("ALTER TABLE hq_audit_events DROP CONSTRAINT test_deletion_failure");
    }
    expect(await store.importedProject(41, PROJECT.externalId)).toEqual({ projectId });
    expect(await rows("SELECT normalized_colosseum_username FROM hq_crm_persons WHERE builder_user_id=$1", [OWNER.id]))
      .toEqual([{ normalized_colosseum_username: PROJECT.members[0].username }]);
    expect(await ownTeam(OWNER.id, projectId)).toMatchObject({ id: projectId });
    await expect(importProject(PROJECT, OUTSIDER)).rejects.toMatchObject({ reason: "already_imported" });
  });
});

describe("self-service import", () => {
  it("imports a snapshot and roster references while linking only the selected importing account", async () => {
    const id = await importProject();
    expect(await rows(`SELECT p.name,p.lead_name,p.hackathon_id,o.stage,o.verification,o.country,o.category,o.twitter_handle,
      o.repo_link,(o.submitted_at AT TIME ZONE 'UTC')::text AS submitted_at,o.submission_status,o.source_status,o.external_hackathon_id,o.external_hackathon_slug,o.raw
      FROM hq_projects p JOIN hq_project_onboarding o ON o.project_id=p.id WHERE p.id=$1`, [id]))
      .toEqual([{ name: "Tulip Ledger", lead_name: "Fictional Builder One", hackathon_id: 41, stage: "idea",
        // The owner's decision: a successful import writes 'verified', so
        // every existing membership reader keeps working. The step is gone,
        // the column is not.
        verification: "verified", country: "Netherlands", category: "Payments & Remittance", twitter_handle: "tulipledger",
        repo_link: "https://github.com/example/project", submitted_at: "2026-05-11 20:00:00", submission_status: "submitted",
        source_status: "ok", external_hackathon_id: 6, external_hackathon_slug: "frontier", raw: PROJECT.raw }]);
    expect(await rows(`SELECT name,colosseum_username,avatar_url,builder_user_id,person_id IS NOT NULL AS has_person
      FROM hq_project_members WHERE project_id=$1 ORDER BY sort`, [id])).toEqual([
      { name: "Fictional Builder One", colosseum_username: "fictional_builder_1", avatar_url: null, builder_user_id: OWNER.id, has_person: true },
      { name: "Fictional Builder Two", colosseum_username: "fictional_builder_2", avatar_url: "https://static.example.test/two.png", builder_user_id: null, has_person: false },
    ]);
    // Only the already registered accounts have People cards.
    expect(await rows(`SELECT name FROM hq_people WHERE hackathon_id=41 ORDER BY name`))
      .toEqual([{ name: "Outsider" }, { name: "Owner" }, { name: "Teammate" }]);
    expect(await rows("SELECT normalized_colosseum_username FROM hq_crm_persons WHERE normalized_colosseum_username IS NOT NULL ORDER BY 1"))
      .toEqual([{ normalized_colosseum_username: "fictional_builder_1" }]);
    expect(await rows("SELECT message FROM hq_activity")).toEqual([{ message: "Tulip Ledger imported from Colosseum" }]);
  });

  it("puts the imported team straight into weekly reporting, with the edition's schedule", async () => {
    const id = await importProject();
    expect(await rows(`SELECT project_id::text AS project_id, hackathon_id, paused_at, enabled_by_user_id FROM hq_reporting_eligibility`))
      .toEqual([{ project_id: id, hackathon_id: 41, paused_at: null, enabled_by_user_id: null }]);
    // "Store period identities once reporting begins": the first import in an
    // edition brings that edition's periods with it.
    expect(await rows(`SELECT count(*)::int AS n FROM hq_reporting_periods WHERE hackathon_id=41`)).toEqual([{ n: 5 }]);
    // Entering reporting is part of the import's own audit trail, not a
    // second operator-attributed event.
    expect(await rows(`SELECT count(*)::int AS n FROM hq_audit_events WHERE kind='reporting.eligibility_changed'`)).toEqual([{ n: 0 }]);
  });

  it("leaves no eligibility row behind when the import itself rolls back", async () => {
    await importProject();
    await expect(store.importTeam(OUTSIDER, { selectedUsername: PROJECT.members[0].username, hackathonId: 41, project: PROJECT, projectUrl: PROJECT_URL }))
      .rejects.toMatchObject({ reason: "already_imported" });
    expect(await rows(`SELECT count(*)::int AS n FROM hq_reporting_eligibility`)).toEqual([{ n: 1 }]);
  });

  it("reports an already-imported project rather than creating a second team", async () => {
    await importProject();
    await expect(store.importTeam(OUTSIDER, { selectedUsername: PROJECT.members[0].username, hackathonId: 41, project: PROJECT, projectUrl: PROJECT_URL }))
      .rejects.toMatchObject({ reason: "already_imported" });
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 1 }]);
    expect(await rows("SELECT owner_user_id FROM hq_project_onboarding")).toEqual([{ owner_user_id: OWNER.id }]);
  });

  it("refuses a simultaneous second import of the same project without leaving a half-written team", async () => {
    const results = await Promise.allSettled([
      store.importTeam(OWNER, { selectedUsername: PROJECT.members[0].username, hackathonId: 41, project: PROJECT, projectUrl: PROJECT_URL }),
      store.importTeam(OUTSIDER, { selectedUsername: PROJECT.members[0].username, hackathonId: 41, project: PROJECT, projectUrl: PROJECT_URL }),
    ]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 1 }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_project_onboarding")).toEqual([{ n: 1 }]);
  });

  it.each([
    ["not_dutch", { ...PROJECT, country: "Belgium" }],
    ["not_dutch", { ...PROJECT, country: null }],
    ["wrong_edition", { ...PROJECT, hackathon: { id: 7, slug: "next-edition", name: "Next" } }],
  ])("refuses with reason %s and writes nothing", async (reason, project) => {
    await expect(store.importTeam(OWNER, { selectedUsername: PROJECT.members[0].username, hackathonId: 41, project, projectUrl: PROJECT_URL })).rejects.toMatchObject({ reason });
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_activity")).toEqual([{ n: 0 }]);
  });

  it("refuses when the edition mapping is unset rather than comparing against null", async () => {
    await db.query("UPDATE hq_hackathon_onboarding SET external_hackathon_id=NULL WHERE hackathon_id=41");
    await expect(store.importTeam(OWNER, { selectedUsername: PROJECT.members[0].username, hackathonId: 41, project: PROJECT, projectUrl: PROJECT_URL }))
      .rejects.toMatchObject({ reason: "edition_not_configured" });
    expect(gateProject(PROJECT, { externalId: null, projectsOpen: true, projectsAvailableAt: null }))
      .toBe("edition_not_configured");
  });

  it.each(["projects_open=false", "projects_available_at=now()+interval '1 day'"])("refuses while imports are closed: %s", async (change) => {
    await db.query(`UPDATE hq_hackathon_onboarding SET ${change} WHERE hackathon_id=41`);
    await expect(store.importTeam(OWNER, { selectedUsername: PROJECT.members[0].username, hackathonId: 41, project: PROJECT, projectUrl: PROJECT_URL }))
      .rejects.toMatchObject({ reason: "imports_closed" });
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 0 }]);
  });

  it("rolls the whole import back if any part of it fails", async () => {
    await db.query("ALTER TABLE hq_activity ADD CONSTRAINT test_activity_failure CHECK (message='')");
    try {
      await expect(store.importTeam(OWNER, { selectedUsername: PROJECT.members[0].username, hackathonId: 41, project: PROJECT, projectUrl: PROJECT_URL })).rejects.toThrow();
      expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 0 }]);
      expect(await rows("SELECT count(*)::int AS n FROM hq_project_members")).toEqual([{ n: 0 }]);
      expect(await rows("SELECT count(*)::int AS n FROM hq_crm_persons WHERE normalized_colosseum_username IS NOT NULL")).toEqual([{ n: 0 }]);
    } finally { await db.query("ALTER TABLE hq_activity DROP CONSTRAINT test_activity_failure"); }
  });

  it("gives one People card per person per edition, even when two teams share a roster member", async () => {
    await importProject();
    const second = { ...PROJECT, externalId: 90002, slug: "orchid-relay", name: "Orchid Relay",
      members: [PROJECT.members[1], { username: "fictional_builder_3", displayName: "Fictional Builder Three", avatarUrl: null }] };
    await store.importTeam(OUTSIDER, { selectedUsername: second.members[1].username, hackathonId: 41, project: second, projectUrl: "https://colosseum.com/arena/projects/explore/orchid-relay" });
    expect(await rows(`SELECT count(*)::int AS n FROM hq_people WHERE hackathon_id=41 AND name='Fictional Builder Two'`)).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_crm_persons WHERE normalized_colosseum_username='fictional_builder_2'")).toEqual([{ n: 0 }]);
  });
});

describe("refreshing a team's Colosseum snapshot", () => {
  it.each(["project", "source edition", "HQ edition"])("refuses a refresh for a different %s without changing the snapshot or roster", async mismatch => {
    const id = await importProject();
    const before = await ownTeam(OWNER.id, id);
    const project = {
      ...PROJECT, name: "Wrong team", description: "Wrong source",
      externalId: mismatch === "project" ? 99999 : PROJECT.externalId,
      hackathon: mismatch === "source edition" ? { ...PROJECT.hackathon, id: 999 } : PROJECT.hackathon,
      members: [{ username: "wrong_member", displayName: "Wrong Member", avatarUrl: null }],
    };
    await expect(store.refreshTeam({ projectId: id, hackathonId: mismatch === "HQ edition" ? 42 : 41, project })).rejects.toThrow();
    expect(await ownTeam(OWNER.id, id)).toEqual(before);
    expect(await rows("SELECT id FROM hq_crm_persons WHERE normalized_colosseum_username='wrong_member'")).toEqual([]);
  });

  it("updates the snapshot and adds new roster members without touching HQ state", async () => {
    const id = await importProject();
    const team = await ownTeam(OWNER.id, id);
    const teammate = team.members.find(member => member.username === "fictional_builder_2")!;
    const code = await store.createInvite(OWNER.id, id);
    await store.redeemInvite(TEAMMATE, code, teammate.id);
    await store.updateTeam(OWNER.id, id, "beta", "fictional_builder_2");
    await db.query("INSERT INTO hq_project_notes(project_id,body) VALUES($1,'Operator note that must survive')", [id]);
    await db.query("INSERT INTO hq_captain_assignments(project_id,captain_user_id) VALUES($1,$2)", [id, OUTSIDER.id]);

    const later = { ...PROJECT, name: "Tulip Ledger v2", description: "Updated on Colosseum", submittedAt: null,
      members: [PROJECT.members[0], PROJECT.members[1], { username: "fictional_builder_9", displayName: "Fictional Builder Nine", avatarUrl: null }] };
    const submission = await store.refreshTeam({ projectId: id, hackathonId: 41, project: later });
    // A checked project whose submittedAt is null reads as Not submitted: the
    // draft signal was confirmed live on 2026-09-14 (see
    // lib/hq/colosseum-snapshot.ts#DRAFT_SIGNAL_CONFIRMED).
    expect(submission).toBe("not_submitted");

    const refreshed = await ownTeam(OWNER.id, id);
    expect(refreshed).toMatchObject({ name: "Tulip Ledger v2", description: "Updated on Colosseum", stage: "beta", leadUsername: "fictional_builder_2", ownerId: OWNER.id, verification: "verified" });
    expect(refreshed.members.map(member => member.username)).toEqual(["fictional_builder_1", "fictional_builder_2", "fictional_builder_9"]);
    expect(refreshed.members.find(member => member.username === "fictional_builder_2")?.joined).toBe(true);
    expect(await rows("SELECT body FROM hq_project_notes WHERE project_id=$1", [id])).toEqual([{ body: "Operator note that must survive" }]);
    expect(await rows("SELECT source_status,source_checked_at IS NOT NULL AS checked FROM hq_project_onboarding WHERE project_id=$1", [id]))
      .toEqual([{ source_status: "ok", checked: true }]);
    // The Captain assignment is phase 4's row on this project; a refresh
    // never touches it.
    expect(await rows("SELECT captain_user_id FROM hq_captain_assignments WHERE project_id=$1 AND unassigned_at IS NULL", [id]))
      .toEqual([{ captain_user_id: OUTSIDER.id }]);
  });

  it("keeps a member who left the Colosseum roster, and their claimed HQ membership", async () => {
    const id = await importProject();
    const team = await ownTeam(OWNER.id, id);
    const teammate = team.members.find(member => member.username === "fictional_builder_2")!;
    await store.redeemInvite(TEAMMATE, await store.createInvite(OWNER.id, id), teammate.id);
    await store.refreshTeam({ projectId: id, hackathonId: 41, project: { ...PROJECT, members: [PROJECT.members[0]] } });
    const refreshed = await ownTeam(OWNER.id, id);
    expect(refreshed.members.map(member => member.username)).toEqual(["fictional_builder_1", "fictional_builder_2"]);
    expect((await store.teams(TEAMMATE.id)).map(item => item.id)).toEqual([id]);
  });

  it("is idempotent: the same response applied twice changes nothing", async () => {
    const id = await importProject();
    await store.refreshTeam({ projectId: id, hackathonId: 41, project: PROJECT });
    const first = await rows("SELECT id,name,colosseum_username,person_id FROM hq_project_members WHERE project_id=$1 ORDER BY sort", [id]);
    await store.refreshTeam({ projectId: id, hackathonId: 41, project: PROJECT });
    expect(await rows("SELECT id,name,colosseum_username,person_id FROM hq_project_members WHERE project_id=$1 ORDER BY sort", [id])).toEqual(first);
    expect(await rows("SELECT count(*)::int AS n FROM hq_people WHERE hackathon_id=41")).toEqual([{ n: 3 }]);
  });

  it("a failed check records the failure and keeps the last known submission status", async () => {
    const id = await importProject();
    await store.recordSourceFailure(id, "TIMED_OUT", "upstream text for operators only");
    expect(await rows(`SELECT submission_status,source_status,source_error_code,source_error_message,source_checked_at IS NOT NULL AS checked
      FROM hq_project_onboarding WHERE project_id=$1`, [id]))
      .toEqual([{ submission_status: "submitted", source_status: "error", source_error_code: "TIMED_OUT",
        source_error_message: "upstream text for operators only", checked: true }]);
  });
});

describe("project invitations and team access", () => {
  it("allows owners and joined teammates to share a project link, excluding outsiders", async () => {
    const item = await invite();
    await expect(store.createInvite(OUTSIDER.id, item.projectId)).rejects.toThrow("Only a team member");
    await store.redeemInvite(TEAMMATE, item.code, item.memberId);
    const teammateCode = await store.createInvite(TEAMMATE.id, item.projectId);
    expect(teammateCode).toBe(item.code);
    expect(await store.invitation(teammateCode)).toMatchObject({ ok: true, data: { members: [] } });
    expect(await rows("SELECT member_id,expires_at,consumed_at FROM hq_team_invites"))
      .toEqual([{ member_id: null, expires_at: null, consumed_at: null }]);
  });

  it("accepts a pasted link or code while resolving through token hashes", async () => {
    const item = await invite();
    for (const pasted of [item.code, `  ${item.code}  `, `https://hq.example.test${joinLink(item.code)}/?utm_source=telegram#fragment`]) {
      expect(await store.invitation(parseJoinCode(pasted)!)).toMatchObject({ ok: true, data: {
        projectName: "Tulip Ledger", members: [{ id: item.memberId, username: "fictional_builder_2" }],
      } });
    }
    const [{ token_hash }] = await rows("SELECT token_hash FROM hq_team_invites");
    expect(token_hash).not.toBe(item.code.replaceAll("-", ""));
    expect(String(token_hash)).toMatch(/^[a-f0-9]{64}$/);
    const newer = await store.createInvite(OWNER.id, item.projectId);
    expect(await store.invitation(item.code)).toMatchObject({ ok: true });
    expect(newer).toBe(item.code);
    expect(await store.invitation(newer)).toMatchObject({ ok: true });
  });

  it("reuses one link for different people, with no duplicate People cards", async () => {
    const item = await invite();
    await store.refreshTeam({ projectId: item.projectId, hackathonId: 41, project: { ...PROJECT,
      members: [...PROJECT.members, { username: "third_builder", displayName: "Third Builder", avatarUrl: null }] } });
    const lookup = await store.invitation(item.code);
    if (!lookup.ok) throw new Error("expected invitation");
    const third = lookup.data.members.find(member => member.username === "third_builder")!;
    expect(await store.redeemInvite(TEAMMATE, item.code, item.memberId)).toBe(item.projectId);
    expect(await store.redeemInvite(OUTSIDER, item.code, third.id)).toBe(item.projectId);
    expect(await store.invitation(item.code)).toMatchObject({ ok: true, data: { members: [] } });
    expect(await rows("SELECT consumed_at FROM hq_team_invites")).toEqual([{ consumed_at: null }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_people WHERE hackathon_id=41")).toEqual([{ n: 3 }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_crm_persons")).toEqual([{ n: 3 }]);
    expect(await store.joinedSeat(item.projectId, TEAMMATE.id)).toBe(item.memberId);
  });

  it("serializes competing claims for one seat and leaves the reusable link open", async () => {
    const item = await invite();
    const results = await Promise.allSettled([
      store.redeemInvite(TEAMMATE, item.code, item.memberId), store.redeemInvite(OUTSIDER, item.code, item.memberId),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await rows("SELECT consumed_at FROM hq_team_invites")).toEqual([{ consumed_at: null }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_project_members WHERE id=$1 AND builder_user_id IS NOT NULL", [item.memberId])).toEqual([{ n: 1 }]);
  });

  it("allows an identical retry but cannot claim a second seat for one account", async () => {
    const item = await invite();
    await store.refreshTeam({ projectId: item.projectId, hackathonId: 41, project: { ...PROJECT,
      members: [...PROJECT.members, { username: "third_builder", displayName: "Third Builder", avatarUrl: null }] } });
    const lookup = await store.invitation(item.code);
    if (!lookup.ok) throw new Error("expected invitation");
    const third = lookup.data.members.find(member => member.username === "third_builder")!;
    await store.redeemInvite(TEAMMATE, item.code, item.memberId);
    expect(await store.redeemInvite(TEAMMATE, item.code, item.memberId)).toBe(item.projectId);
    await expect(store.redeemInvite(TEAMMATE, item.code, third.id)).rejects.toThrow("already joined");
    expect(await rows("SELECT builder_user_id FROM hq_project_members WHERE id=$1", [third.id])).toEqual([{ builder_user_id: null }]);
  });

  it("serializes simultaneous selections of different seats by the same account", async () => {
    const item = await invite();
    await store.refreshTeam({ projectId: item.projectId, hackathonId: 41, project: { ...PROJECT,
      members: [...PROJECT.members, { username: "third_builder", displayName: "Third Builder", avatarUrl: null }] } });
    const lookup = await store.invitation(item.code);
    if (!lookup.ok) throw new Error("expected invitation");
    const results = await Promise.allSettled(lookup.data.members.map(member => store.redeemInvite(TEAMMATE,item.code,member.id)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await rows("SELECT count(*)::int AS n FROM hq_project_members WHERE project_id=$1 AND builder_user_id=$2", [item.projectId,TEAMMATE.id]))
      .toEqual([{ n: 1 }]);
  });

  it("upgrades legacy invite constraints without changing old links or stored people", async () => {
    const item = await invite();
    await db.query("UPDATE hq_team_invites SET member_id=$1,expires_at=now()+interval '2 days',share_code=NULL", [item.memberId]);
    await pg.exec("ALTER TABLE hq_team_invites ALTER COLUMN member_id SET NOT NULL; ALTER TABLE hq_team_invites ALTER COLUMN expires_at SET NOT NULL; ALTER TABLE hq_team_invites ALTER COLUMN expires_at SET DEFAULT (now()+interval '2 days')");
    const old = await rows("SELECT id,member_id,token_hash,expires_at,consumed_at FROM hq_team_invites");
    const people = await rows("SELECT id,person_id,builder_user_id FROM hq_people ORDER BY id");
    const schema = readFileSync(join(process.cwd(),"scripts/hq/builder-schema.sql"),"utf8");
    await pg.exec(schema);
    expect(await rows("SELECT id,member_id,token_hash,expires_at,consumed_at FROM hq_team_invites")).toEqual(old);
    expect(await rows("SELECT id,person_id,builder_user_id FROM hq_people ORDER BY id")).toEqual(people);
    const shared = await store.createInvite(OWNER.id,item.projectId);
    expect(shared).not.toBe(item.code);
    // The old app may still issue a seat link while the new deployment is
    // rolling out. Its INSERT omits expiry and must still get two days.
    const [oldAppLink] = await rows(`INSERT INTO hq_team_invites(project_id,member_id,created_by,token_hash)
      VALUES($1,$2,$3,'legacy-during-rollout') RETURNING expires_at IS NOT NULL AS expires,
        expires_at BETWEEN now()+interval '47 hours' AND now()+interval '49 hours' AS two_days`,
      [item.projectId,item.memberId,OWNER.id]);
    expect(oldAppLink).toEqual({ expires: true, two_days: true });
    expect(await rows("SELECT expires_at FROM hq_team_invites WHERE project_id=$1 AND member_id IS NULL", [item.projectId]))
      .toEqual([{ expires_at: null }]);
    await pg.exec(schema);
    expect(await store.createInvite(OWNER.id,item.projectId)).toBe(shared);
    expect(await store.invitation(item.code)).toMatchObject({ ok: true, data: { members: [{ id: item.memberId }] } });
  });

  it("does not transfer a legacy roster identity linked to another account", async () => {
    const item = await invite();
    const rosterPersonId = await ensurePersonForRosterMember(db, { colosseumUsername: "fictional_builder_2", displayName: "Fictional Builder Two" });
    await db.query("UPDATE hq_project_members SET person_id=$1 WHERE id=$2", [rosterPersonId, item.memberId]);
    const correction = await correctPersonMatch(db, { personId: rosterPersonId, toUserId: OUTSIDER.id,
      actor: { kind: "operator", id: "00000000-0000-4000-8000-000000000001" }, reason: "Confirmed this account" });
    await expect(store.redeemInvite(TEAMMATE, item.code, item.memberId)).rejects.toThrow("already linked to another HQ account");
    expect(await rows("SELECT builder_user_id FROM hq_crm_persons WHERE id=$1", [correction.survivingPersonId])).toEqual([{ builder_user_id: OUTSIDER.id }]);
    expect(await rows("SELECT builder_user_id FROM hq_project_members WHERE id=$1", [item.memberId])).toEqual([{ builder_user_id: null }]);
    expect(await store.redeemInvite(OUTSIDER, item.code, item.memberId)).toBe(item.projectId);
  });

  it("preserves existing member-bound links without broadening or reusing them", async () => {
    const item = await invite();
    await db.query("UPDATE hq_team_invites SET member_id=$1,expires_at=now()+interval '2 days'", [item.memberId]);
    const own = (await ownTeam(OWNER.id,item.projectId)).members.find(member => member.username === "fictional_builder_1")!;
    await expect(store.redeemInvite(OUTSIDER,item.code,own.id)).rejects.toThrow("older join link");
    expect(await store.redeemInvite(TEAMMATE,item.code,item.memberId)).toBe(item.projectId);
    expect(await store.invitation(item.code)).toEqual({ ok: false, reason: "used" });
    expect(await rows("SELECT consumed_by FROM hq_team_invites")).toEqual([{ consumed_by: TEAMMATE.id }]);
  });

  it("lets a legacy importer choose their own still-unclaimed entry", async () => {
    const item = await invite();
    const own = (await ownTeam(OWNER.id,item.projectId)).members.find(member => member.username === "fictional_builder_1")!;
    await db.query("UPDATE hq_project_members SET builder_user_id=NULL,joined_at=NULL WHERE id=$1", [own.id]);
    expect(await store.joinedSeat(item.projectId,OWNER.id)).toBeNull();
    expect(await store.redeemInvite(OWNER,item.code,own.id)).toBe(item.projectId);
    expect(await store.joinedSeat(item.projectId,OWNER.id)).toBe(own.id);
    expect(await rows("SELECT count(*)::int AS n FROM hq_people WHERE builder_user_id=$1 AND hackathon_id=41", [OWNER.id])).toEqual([{ n: 1 }]);
  });

  it.each([
    ["expired", "UPDATE hq_team_invites SET expires_at=now()-interval '1 second'"],
    ["other_edition", "UPDATE hq_project_onboarding SET verification='rejected'"],
    ["other_edition", "UPDATE hq_hackathons SET archived_at=now() WHERE id=41"],
  ])("refuses invalid link state %s without revealing the project", async (reason, change) => {
    const item = await invite();
    await db.query(change);
    expect(await store.invitation(item.code)).toEqual({ ok: false, reason });
    await expect(store.redeemInvite(TEAMMATE,item.code,item.memberId)).rejects.toThrow();
  });

  it("refuses a code that was never issued", async () => {
    expect(await store.invitation("AAAAAA-BBBBBB-CCCCCC-DDDDDD")).toEqual({ ok: false, reason: "invalid" });
  });

  it("never lets a missing or removed source entry join, but retains historical HQ membership", async () => {
    const item = await invite();
    await store.refreshTeam({ projectId: item.projectId, hackathonId: 41, project: { ...PROJECT, members: [PROJECT.members[0]] } });
    expect(await store.invitation(item.code)).toMatchObject({ ok: true, data: { members: [] } });
    await expect(store.redeemInvite(TEAMMATE,item.code,item.memberId)).rejects.toThrow("current Colosseum team");
    expect(await store.joinedSeat(item.projectId,OWNER.id)).not.toBeNull();
    expect(await rows("SELECT count(*)::int AS n FROM hq_project_members WHERE project_id=$1", [item.projectId])).toEqual([{ n: 2 }]);
  });

  it("scopes team reads and changes to the owner or joined teammates", async () => {
    const item = await invite();
    expect(await store.teams(OUTSIDER.id)).toEqual([]);
    await expect(ownTeam(OUTSIDER.id,item.projectId)).rejects.toThrow("your account");
    await expect(store.updateTeam(OUTSIDER.id,item.projectId,"live","fictional_builder_1")).rejects.toThrow();
    await store.redeemInvite(TEAMMATE,item.code,item.memberId);
    expect(await ownTeam(TEAMMATE.id,item.projectId)).toMatchObject({ id: item.projectId });
    await expect(store.updateTeam(TEAMMATE.id,item.projectId,"live","fictional_builder_1")).rejects.toThrow();
    await store.updateTeam(OWNER.id,item.projectId,"live","fictional_builder_1");
    expect(await ownTeam(OWNER.id,item.projectId)).toMatchObject({ stage: "live" });
  });

  it.each(["pending", "rejected"])("refuses a team change on a %s claim", async state => {
    const item = await invite();
    await db.query("UPDATE hq_project_onboarding SET verification=$1 WHERE project_id=$2", [state,item.projectId]);
    await expect(store.updateTeam(OWNER.id,item.projectId,"beta","fictional_builder_1")).rejects.toThrow("imported team");
  });
});

// Task T4.4's lock order: assignCaptain (lib/hq/captains.ts) locks the same
// hq_project_onboarding row redeemInvite and importTeam already lock, so
// whichever of an assignment and a membership acceptance for the same
// account and project commits first is what the other's own check sees —
// never both. pgliteBuilderDatabase (tests/hq/helpers/db.ts) serializes
// every transaction on PGlite's one connection, so what follows proves the
// outcome is correct in *either* commit order, not that two truly
// concurrent callers cannot interleave their reads before either commits;
// the lock's own presence is guarded separately, by the source-level tests
// in tests/hq/captains.test.ts, since this harness cannot exercise real
// concurrency to prove it.
describe("Captain assignment races with membership acceptance", () => {
  const OPERATOR_ID = "00000000-0000-4000-8000-000000000001";
  async function seedOperator() {
    await db.query("INSERT INTO hq_users(id,username,display_name,password_hash) VALUES($1,'operator','Operator','unused') ON CONFLICT (id) DO NOTHING", [OPERATOR_ID]);
  }
  async function grantCaptain(userId: string) {
    await grantCapability(db, { actor: { kind: "system", id: null }, byOperatorId: null, userId, capability: "captain", reason: "test" });
  }

  it("ordering 1 (assignment first): a Captain already assigned to a project cannot then join it through a team invite", async () => {
    await seedOperator();
    const item = await invite();
    await grantCaptain(TEAMMATE.id);
    // TEAMMATE's own unclaimed roster row is exactly the unresolved identity
    // the conflict check cannot yet clear on its own — the admin acknowledges
    // it here, by the exact memberId the preview call named.
    const preview = await assignCaptain(db, { actorOperatorId: OPERATOR_ID, projectId: item.projectId, hackathonId: 41, captainUserId: TEAMMATE.id });
    if (preview.outcome !== "needs_review") throw new Error("expected needs_review");
    const assigned = await assignCaptain(db, {
      actorOperatorId: OPERATOR_ID, projectId: item.projectId, hackathonId: 41, captainUserId: TEAMMATE.id,
      acknowledgedUnresolvedIds: preview.unresolved.map((m) => m.memberId),
    });
    expect(assigned.outcome).toBe("assigned");

    await expect(store.redeemInvite(TEAMMATE, item.code, item.memberId)).rejects.toThrow("You currently hold the Captain role for this project");
    // Refused, not silently dropped: the seat is still open and the invite still redeemable once the Captain is reassigned.
    expect(await rows("SELECT builder_user_id FROM hq_project_members WHERE id=$1", [item.memberId])).toEqual([{ builder_user_id: null }]);
    expect(await rows("SELECT consumed_at FROM hq_team_invites WHERE project_id=$1", [item.projectId])).toEqual([{ consumed_at: null }]);
  });

  it("ordering 2 (membership first): a team member who already joined a project cannot then be assigned as its Captain", async () => {
    await seedOperator();
    const item = await invite();
    await grantCaptain(TEAMMATE.id);
    expect(await store.redeemInvite(TEAMMATE, item.code, item.memberId)).toBe(item.projectId);

    const result = await assignCaptain(db, { actorOperatorId: OPERATOR_ID, projectId: item.projectId, hackathonId: 41, captainUserId: TEAMMATE.id });
    expect(result).toEqual({ outcome: "conflict", conflict: { kind: "verified_member", role: "member" } });
  });

  it("the import path: a Captain assigned to an imported project cannot re-import it to become its owner", async () => {
    await seedOperator();
    // Phase 3 removed the claim-recovery path entirely: an external project
    // that is already in HQ cannot be imported again by anyone, so the
    // Captain-becomes-owner ordering this test used to guard is now closed
    // one step earlier and for everyone, not only for the Captain. The
    // refusal is "already imported", and it reveals nothing about who owns
    // the team — including to a Captain of it.
    const id = await importProject();
    await grantCaptain(OUTSIDER.id);
    const preview = await assignCaptain(db, { actorOperatorId: OPERATOR_ID, projectId: id, hackathonId: 41, captainUserId: OUTSIDER.id });
    if (preview.outcome !== "needs_review") throw new Error("expected needs_review");
    const assigned = await assignCaptain(db, {
      actorOperatorId: OPERATOR_ID, projectId: id, hackathonId: 41, captainUserId: OUTSIDER.id,
      acknowledgedUnresolvedIds: preview.unresolved.map((m) => m.memberId),
    });
    expect(assigned.outcome).toBe("assigned");

    await expect(store.importTeam(OUTSIDER, { selectedUsername: PROJECT.members[0].username, hackathonId: 41, project: PROJECT, projectUrl: PROJECT_URL }))
      .rejects.toMatchObject({ reason: "already_imported" });
    expect(await rows("SELECT owner_user_id FROM hq_project_onboarding WHERE project_id=$1", [id])).toEqual([{ owner_user_id: OWNER.id }]);
  });
});

describe("manual requests", () => {
  it("stores an idempotent manual request without fabricating a CRM project", async () => {
    const url = "https://colosseum.com/arena/projects/explore/unpublished";
    await store.requestReview(OWNER, 42, url, "Project access is not open yet.");
    await store.requestReview(OWNER, 42, url, "Please help us when access opens.");
    await store.requestReview(OUTSIDER, 41, `${url}-other`, "Another account's request.");
    expect(await store.tier(OWNER.id)).toBe("regular");
    expect(await rows("SELECT r.project_url,r.status,r.note,h.name FROM hq_project_import_requests r JOIN hq_hackathons h ON h.id=r.hackathon_id WHERE r.user_id=$1", [OWNER.id]))
      .toEqual([{ project_url: url, status: "pending", note: "Please help us when access opens.", name: "Next builders" }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 0 }]);
    expect((await rows("SELECT hackathon_id FROM hq_builder_enrollments WHERE user_id=$1", [OWNER.id])).map(row => row.hackathon_id).sort()).toEqual([41, 42]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_project_import_requests WHERE user_id=$1", [TEAMMATE.id])).toEqual([{ n: 0 }]);
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
    vi.spyOn(identityModule, "getTelegramIdentity").mockResolvedValue(null);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("previews without creating records and requires a current selected roster entry to complete import", async () => {
    const fetcher = vi.fn<ColosseumFetch>(async () => projectResponse());
    vi.stubGlobal("fetch",fetcher);
    expect(await previewColosseumTeam({ hackathonId: 41, url: PROJECT_URL })).toMatchObject({ ok: true, project: {
      name: PROJECT.name, members: [{ username: "fictional_builder_1" }, { username: "fictional_builder_2" }],
    } });
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_crm_persons")).toEqual([{ n: 3 }]);
    fetcher.mockImplementation(async () => projectResponse({ ...PROJECT, members: [PROJECT.members[0]] }));
    expect(await importBuilderTeam({ hackathonId: 41, url: PROJECT_URL, selectedUsername: PROJECT.members[1].username }))
      .toMatchObject({ ok: false, error: "Choose yourself from the Colosseum team." });
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 0 }]);
    fetcher.mockImplementation(async () => projectResponse());
    expect(await importBuilderTeam({ hackathonId: 41, url: PROJECT_URL, selectedUsername: PROJECT.members[1].username })).toMatchObject({ ok: true });
    expect(await rows("SELECT colosseum_username FROM hq_project_members WHERE builder_user_id=$1",[OWNER.id]))
      .toEqual([{ colosseum_username: PROJECT.members[1].username }]);
  });

  it("refreshes a full team's reusable link so someone newly added on Colosseum can join", async () => {
    const item = await invite();
    await store.redeemInvite(TEAMMATE,item.code,item.memberId);
    const fetcher = vi.fn<ColosseumFetch>(async () => projectResponse());
    expect(await previewTeamInvitation(item.code,fetcher)).toMatchObject({ ok: true, data: { members: [], projectUrl: PROJECT_URL } });
    const later = { ...PROJECT, members: [...PROJECT.members, { username: "third_builder", displayName: "Third Builder", avatarUrl: null }] };
    fetcher.mockImplementation(async () => projectResponse(later));
    const preview = await previewTeamInvitation(item.code,fetcher);
    if (!preview.ok) throw new Error(preview.message);
    expect(preview.data.members).toMatchObject([{ username: "third_builder" }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_crm_persons")).toEqual([{ n: 3 }]);
    expect(await store.redeemInvite(OUTSIDER,item.code,preview.data.members[0].id)).toBe(item.projectId);
    expect(await store.createInvite(OUTSIDER.id,item.projectId)).toBe(item.code);
  });

  it.each(["country","edition","project"])("does not add selectable roster entries from a mismatched %s", async mismatch => {
    const item = await invite();
    const bad = { ...PROJECT, country: mismatch === "country" ? "Belgium" : PROJECT.country,
      externalId: mismatch === "project" ? 99999 : PROJECT.externalId,
      hackathon: mismatch === "edition" ? { ...PROJECT.hackathon, id: 999 } : PROJECT.hackathon,
      members: [{ username: "unexpected", displayName: "Unexpected", avatarUrl: null }] };
    expect(await previewTeamInvitation(item.code,async () => projectResponse(bad))).toMatchObject({ ok: false });
    expect(await rows("SELECT id FROM hq_project_members WHERE colosseum_username='unexpected'")).toEqual([]);
    expect(await store.invitation(item.code)).toMatchObject({ ok: true, data: { members: [{ id: item.memberId }] } });
  });

  it("keeps membership unchanged when the current Colosseum roster cannot be checked", async () => {
    const item = await invite();
    actionMocks.requireMember.mockResolvedValue(TEAMMATE);
    const fetcher = vi.fn().mockRejectedValue(new Error("Colosseum is offline"));
    vi.stubGlobal("fetch", fetcher);
    expect(await acceptBuilderInvite({ code: item.code, memberId: item.memberId })).toMatchObject({ ok: false });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await store.joinedSeat(item.projectId,TEAMMATE.id)).toBeNull();
    expect(await store.invitation(item.code)).toMatchObject({ ok: true });
  });

  it("keeps the Request help route usable when Colosseum cannot be fetched at all", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("Colosseum is offline"));
    vi.stubGlobal("fetch", fetcher);
    expect(await requestBuilderReview({ hackathonId: 41, url: `https://colosseum.com/arena/projects/${PROJECT.slug}/?utm_source=telegram#team`, telegramUsername: "  @My_Builder  " }))
      .toEqual({ ok: true, data: { url: "/hq/dashboard" } });
    // The route parses the link locally and records the request; it never
    // depends on the source being reachable, which is the whole point of it.
    expect(fetcher).not.toHaveBeenCalled();
    expect(await rows("SELECT project_url FROM hq_project_import_requests WHERE user_id=$1", [OWNER.id])).toEqual([
      { project_url: `https://colosseum.com/arena/projects/${PROJECT.slug}` },
    ]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT note FROM hq_project_import_requests WHERE user_id=$1", [OWNER.id]))
      .toEqual([{ note: "Import help requested. Telegram contact (provided): @My_Builder." }]);
    expect(identityModule.getTelegramIdentity).toHaveBeenCalledWith(OWNER.id);
  });

  it.each([undefined, "", "   ", "@", "@@builder", "my builder", "https://t.me/builder", "a".repeat(33)])(
    "requires a valid contact username for an unconnected account (%s)", async telegramUsername => {
      expect(await requestBuilderReview({ hackathonId: 41, url: PROJECT_URL, telegramUsername }))
        .toEqual({ ok: false, error: "Enter your Telegram username, such as @yourname.", field: "telegramUsername" });
      expect(await rows("SELECT count(*)::int AS n FROM hq_project_import_requests")).toEqual([{ n: 0 }]);
    },
  );

  it.each(["linked_builder", null])("uses the current Telegram connection without requiring a username (%s)", async username => {
    vi.mocked(identityModule.getTelegramIdentity).mockResolvedValue({
      userId: OWNER.id, telegramUserId: "9007199254740993", providerSubject: "telegram-subject",
      username, photoUrl: null, linkedAt: "2026-09-01T00:00:00.000Z", lastLoginAt: "2026-09-01T00:00:00.000Z",
    });
    expect(await requestBuilderReview({ hackathonId: 41, url: PROJECT_URL }))
      .toEqual({ ok: true, data: { url: "/hq/dashboard" } });
    // A stale form's manual field cannot replace the current linked contact.
    expect(await requestBuilderReview({ hackathonId: 41, url: PROJECT_URL, telegramUsername: "invalid supplied contact" }))
      .toEqual({ ok: true, data: { url: "/hq/dashboard" } });
    expect(identityModule.getTelegramIdentity).toHaveBeenCalledTimes(2);
    expect(await rows("SELECT note FROM hq_project_import_requests WHERE user_id=$1", [OWNER.id]))
      .toEqual([{ note: username
        ? "Import help requested. Telegram connected as @linked_builder."
        : "Import help requested. Telegram connected to this HQ account." }]);
  });

  it("accepts pasted links up to the main import limit and keeps request help available before project access opens", async () => {
    await db.query("UPDATE hq_hackathon_onboarding SET projects_open=false WHERE hackathon_id=41");
    const longUrl = `${PROJECT_URL}?tracking=${"a".repeat(2048 - PROJECT_URL.length - 10)}`;
    expect(longUrl).toHaveLength(2048);
    expect(await requestBuilderReview({ hackathonId: 41, url: longUrl, telegramUsername: "builder" }))
      .toEqual({ ok: true, data: { url: "/hq/dashboard" } });
    expect(await requestBuilderReview({ hackathonId: 41, url: `${longUrl}a`, telegramUsername: "builder" }))
      .toEqual({ ok: false, error: "Check the details and try again." });
    expect(await rows("SELECT project_url FROM hq_project_import_requests WHERE user_id=$1", [OWNER.id])).toEqual([
      { project_url: `https://colosseum.com/arena/projects/${PROJECT.slug}` },
    ]);
  });

  it("imports through the member action end to end, and answers each Colosseum failure with its own reason", async () => {
    const detailBody = {
      projectType: "HACKATHON",
      project: { id: PROJECT.externalId, hackathonId: PROJECT.hackathon.id, slug: PROJECT.slug, name: PROJECT.name,
        description: PROJECT.description, country: PROJECT.country, category: PROJECT.category,
        twitterHandle: PROJECT.twitterHandle, submittedAt: PROJECT.submittedAt, repoLink: PROJECT.links.repoLink,
        hackathon: PROJECT.hackathon, teamMembers: PROJECT.members.map(m => ({ username: m.username, displayName: m.displayName, avatarUrl: m.avatarUrl })) },
      projectCompletion: { isComplete: true, fieldErrors: [] },
    };
    const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    vi.stubGlobal("fetch", vi.fn(async () => respond({ message: "Project not found.", code: "NOT_FOUND" }, 404)));
    expect(await importBuilderTeam({ selectedUsername: PROJECT.members[0].username, hackathonId: 41, url: PROJECT_URL })).toMatchObject({ ok: false, reason: "not_found", retry: false });

    vi.stubGlobal("fetch", vi.fn(async () => respond({ message: "slow down", code: "RATE_LIMITED" }, 429)));
    expect(await importBuilderTeam({ selectedUsername: PROJECT.members[0].username, hackathonId: 41, url: PROJECT_URL })).toMatchObject({ ok: false, reason: "rate_limited", retry: true });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{broken", { headers: { "Content-Type": "application/json" } })));
    expect(await importBuilderTeam({ selectedUsername: PROJECT.members[0].username, hackathonId: 41, url: PROJECT_URL })).toMatchObject({ ok: false, reason: "unreadable", retry: true });

    vi.stubGlobal("fetch", vi.fn(async () => respond({ ...detailBody, project: { ...detailBody.project, country: "Belgium" } })));
    expect(await importBuilderTeam({ selectedUsername: PROJECT.members[0].username, hackathonId: 41, url: PROJECT_URL })).toMatchObject({ ok: false, reason: "not_dutch", retry: false });

    vi.stubGlobal("fetch", vi.fn(async () => respond({ ...detailBody, project: { ...detailBody.project, hackathonId: 7, hackathon: { id: 7, slug: "next-edition", name: "Next" } } })));
    expect(await importBuilderTeam({ selectedUsername: PROJECT.members[0].username, hackathonId: 41, url: PROJECT_URL })).toMatchObject({ ok: false, reason: "wrong_edition", retry: false });

    expect(await importBuilderTeam({ selectedUsername: PROJECT.members[0].username, hackathonId: 41, url: "https://example.com/not-colosseum" })).toMatchObject({ ok: false, reason: "invalid_url" });

    const calls = vi.fn<ColosseumFetch>(async () => respond(detailBody));
    vi.stubGlobal("fetch", calls);
    const imported = await importBuilderTeam({ selectedUsername: PROJECT.members[0].username, hackathonId: 41, url: `https://colosseum.com/arena/projects/${PROJECT.slug}?utm_source=telegram#team` });
    expect(imported.ok).toBe(true);
    expect(calls).toHaveBeenCalledOnce();
    expect(String(calls.mock.calls[0][0])).toBe(`https://api.colosseum.com/api/project?slug=${PROJECT.slug}&type=HACKATHON`);
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 1 }]);
    expect(await rows("SELECT project_url FROM hq_project_onboarding")).toEqual([
      { project_url: `https://colosseum.com/arena/projects/${PROJECT.slug}` },
    ]);

    // The distinct outcome the plan singles out: already imported, routed to
    // help rather than to a retry, revealing nothing about who owns it.
    const second = await importBuilderTeam({ selectedUsername: PROJECT.members[0].username, hackathonId: 41, url: PROJECT_URL });
    expect(second).toMatchObject({ ok: false, reason: "already_imported", retry: false });
    expect("error" in second && second.error).not.toContain(OWNER.name);

    expect(await rows("SELECT kind,actor_kind FROM hq_audit_events WHERE kind='project.imported'"))
      .toEqual([{ kind: "project.imported", actor_kind: "member" }]);
  });
});
