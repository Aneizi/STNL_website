import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportedProject } from "@/lib/colosseum-api";
import { BuilderStore, type BuilderDatabase } from "@/lib/hq/builder-store";
import * as builderModule from "@/lib/hq/builder-store";
import type { BuilderIdentity } from "@/lib/hq/builder-types";
import { grantCapability } from "@/lib/hq/capabilities";
import { assignCaptain } from "@/lib/hq/captains";
import { correctPersonMatch, ensurePersonForRosterMember, linkPersonToAccount, normalizeColosseumUsername } from "@/lib/hq/crm-identity";
import { applyUpgrades } from "@/scripts/hq/upgrades";
import { pgliteBuilderDatabase } from "./helpers/db";

vi.mock("server-only", () => ({}));
const actionMocks = vi.hoisted(() => ({ requireMember: vi.fn() }));
vi.mock("@/lib/hq/member-auth", () => ({ requireMember: actionMocks.requireMember }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { chooseBuilderPath, importBuilderTeam, requestBuilderReview } from "@/lib/hq/actions/builders";
import { JOIN_LINK_MESSAGES } from "@/lib/hq/builder-types";
import { joinLink, parseJoinCode } from "@/lib/hq/member-routes";
import { gateProject } from "@/lib/hq/project-import";

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

let pg: PGlite;
let db: BuilderDatabase;
let store: BuilderStore;

async function rows(text: string, values?: unknown[]) { return (await db.query(text, values)).rows; }

async function prepareUsers() {
  await Promise.all([OWNER, TEAMMATE, OUTSIDER].map(user => store.syncAccount(user)));
}

/** One self-service import: no challenge, no proof, no approval — the whole flow is this call. */
async function importProject(project = PROJECT, owner = OWNER, hackathonId = 41) {
  return store.importTeam(owner, { hackathonId, project, projectUrl: `https://colosseum.com/arena/projects/explore/${project.slug}` });
}

async function invite() {
  const id = await importProject();
  const team = await store.team(OWNER.id, id);
  const member = team.members.find(item => item.username === "fictional_builder_2")!;
  return { projectId: id, memberId: member.id, code: await store.createInvite(OWNER.id, id, member.id) };
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

  it("enrolls without tripping the per-edition person index when another card already carries the account's person", async () => {
    const [{ id: own }] = await rows("SELECT id FROM hq_crm_persons WHERE builder_user_id=$1", [OWNER.id]);
    // Edition 41: the account's card is unstamped while a roster card carries
    // its person, the state a person-match link can leave behind. Edition
    // 42: no card for the account yet, a roster card already carries it.
    await db.query("UPDATE hq_people SET person_id=NULL WHERE builder_user_id=$1 AND hackathon_id=41", [OWNER.id]);
    for (const edition of [41, 42]) {
      await db.query(`INSERT INTO hq_people(hackathon_id,name,role_id,person_id) SELECT $1,'Owner (roster card)',id,$2 FROM hq_people_roles WHERE label='Builder'`, [edition, own]);
    }
    await expect(store.enroll(OWNER, 41, "builder")).resolves.toBeUndefined();
    await expect(store.enroll(OWNER, 42, "supporter")).resolves.toBeUndefined();
    expect(await rows(`SELECT p.hackathon_id,p.person_id,r.label FROM hq_people p JOIN hq_people_roles r ON r.id=p.role_id
      WHERE p.builder_user_id=$1 ORDER BY p.hackathon_id`, [OWNER.id])).toEqual([
      { hackathon_id: 41, person_id: null, label: "Builder" },
      { hackathon_id: 42, person_id: null, label: "Community" },
    ]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_people WHERE person_id=$1", [own])).toEqual([{ n: 2 }]);
    // Once the other card is gone, the next enrolment stamps the account's card as before.
    await db.query("DELETE FROM hq_people WHERE person_id=$1 AND builder_user_id IS NULL AND hackathon_id=41", [own]);
    await store.enroll(OWNER, 41, "builder");
    expect(await rows("SELECT person_id FROM hq_people WHERE builder_user_id=$1 AND hackathon_id=41", [OWNER.id])).toEqual([{ person_id: own }]);
  });

  it("rejects unavailable editions without leaving a People card or enrollment", async () => {
    await expect(store.enroll(OWNER, 43, "builder")).rejects.toThrow("available hackathon");
    await expect(store.enroll(OWNER, 999, "builder")).rejects.toThrow("available hackathon");
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
    await store.enroll({ ...TELEGRAM_ONLY, email: PLACEHOLDER }, 42, "supporter");
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
    await store.enroll(OWNER, 42, "builder");
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
    // Three accounts, the two roster persons phase 3's import now creates,
    // and the two fresh persons the clears above handed back to the accounts.
    expect(await rows("SELECT count(*)::int AS n FROM hq_crm_persons")).toEqual([{ n: 7 }]);
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
    await expect(store.enroll({ id: "auth-legacy", email: null, name: "Legacy Builder" }, 41, "builder")).resolves.toBeUndefined();
    expect((await card("auth-legacy", 41)).person_id).toBeNull();
    expect(await rows("SELECT count(*)::int AS n FROM hq_people WHERE hackathon_id=41 AND person_id=$1", [roster])).toEqual([{ n: 1 }]);
  });

  it("merges a roster person into the account's own person: cards and roster rows follow, a collision is reported, the username moves", async () => {
    const [{ id: own }] = await personOf(OWNER.id);
    const roster = await ensurePersonForRosterMember(db, { colosseumUsername: "fictional_builder_1", displayName: "Fictional Builder One" });
    const colliding = await rosterCard(41, roster);
    const moving = await rosterCard(42, roster);
    await importProject();
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
    expect(await events()).toEqual([expect.objectContaining({ kind: "project.imported" }), expect.objectContaining({
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

describe("self-service import", () => {
  it("imports the project, its normalized snapshot, its roster and its People identities in one step", async () => {
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
      { name: "Fictional Builder One", colosseum_username: "fictional_builder_1", avatar_url: null, builder_user_id: null, has_person: true },
      { name: "Fictional Builder Two", colosseum_username: "fictional_builder_2", avatar_url: "https://static.example.test/two.png", builder_user_id: null, has_person: true },
    ]);
    // A People card per roster person, plus the importer's own account card.
    expect(await rows(`SELECT name FROM hq_people WHERE hackathon_id=41 ORDER BY name`))
      .toEqual([{ name: "Fictional Builder One" }, { name: "Fictional Builder Two" }, { name: "Outsider" }, { name: "Owner" }, { name: "Teammate" }]);
    expect(await rows("SELECT normalized_colosseum_username FROM hq_crm_persons WHERE normalized_colosseum_username IS NOT NULL ORDER BY 1"))
      .toEqual([{ normalized_colosseum_username: "fictional_builder_1" }, { normalized_colosseum_username: "fictional_builder_2" }]);
    expect(await rows("SELECT message FROM hq_activity")).toEqual([{ message: "Tulip Ledger imported from Colosseum" }]);
  });

  it("reports an already-imported project rather than creating a second team", async () => {
    await importProject();
    await expect(store.importTeam(OUTSIDER, { hackathonId: 41, project: PROJECT, projectUrl: PROJECT_URL }))
      .rejects.toMatchObject({ reason: "already_imported" });
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 1 }]);
    expect(await rows("SELECT owner_user_id FROM hq_project_onboarding")).toEqual([{ owner_user_id: OWNER.id }]);
  });

  it("refuses a simultaneous second import of the same project without leaving a half-written team", async () => {
    const results = await Promise.allSettled([
      store.importTeam(OWNER, { hackathonId: 41, project: PROJECT, projectUrl: PROJECT_URL }),
      store.importTeam(OUTSIDER, { hackathonId: 41, project: PROJECT, projectUrl: PROJECT_URL }),
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
    await expect(store.importTeam(OWNER, { hackathonId: 41, project, projectUrl: PROJECT_URL })).rejects.toMatchObject({ reason });
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_activity")).toEqual([{ n: 0 }]);
  });

  it("refuses when the edition mapping is unset rather than comparing against null", async () => {
    await db.query("UPDATE hq_hackathon_onboarding SET external_hackathon_id=NULL WHERE hackathon_id=41");
    await expect(store.importTeam(OWNER, { hackathonId: 41, project: PROJECT, projectUrl: PROJECT_URL }))
      .rejects.toMatchObject({ reason: "edition_not_configured" });
    expect(gateProject(PROJECT, { hackathonId: 41, externalId: null, externalSlug: null, projectsOpen: true, projectsAvailableAt: null }))
      .toBe("edition_not_configured");
  });

  it.each(["projects_open=false", "projects_available_at=now()+interval '1 day'"])("refuses while imports are closed: %s", async (change) => {
    await db.query(`UPDATE hq_hackathon_onboarding SET ${change} WHERE hackathon_id=41`);
    await expect(store.importTeam(OWNER, { hackathonId: 41, project: PROJECT, projectUrl: PROJECT_URL }))
      .rejects.toMatchObject({ reason: "imports_closed" });
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 0 }]);
  });

  it("rolls the whole import back if any part of it fails", async () => {
    await db.query("ALTER TABLE hq_activity ADD CONSTRAINT test_activity_failure CHECK (message='')");
    try {
      await expect(store.importTeam(OWNER, { hackathonId: 41, project: PROJECT, projectUrl: PROJECT_URL })).rejects.toThrow();
      expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 0 }]);
      expect(await rows("SELECT count(*)::int AS n FROM hq_project_members")).toEqual([{ n: 0 }]);
      expect(await rows("SELECT count(*)::int AS n FROM hq_crm_persons WHERE normalized_colosseum_username IS NOT NULL")).toEqual([{ n: 0 }]);
    } finally { await db.query("ALTER TABLE hq_activity DROP CONSTRAINT test_activity_failure"); }
  });

  it("gives one People card per person per edition, even when two teams share a roster member", async () => {
    await importProject();
    const second = { ...PROJECT, externalId: 90002, slug: "orchid-relay", name: "Orchid Relay",
      members: [PROJECT.members[1], { username: "fictional_builder_3", displayName: "Fictional Builder Three", avatarUrl: null }] };
    await store.importTeam(OUTSIDER, { hackathonId: 41, project: second, projectUrl: "https://colosseum.com/arena/projects/explore/orchid-relay" });
    expect(await rows(`SELECT count(*)::int AS n FROM hq_people WHERE hackathon_id=41 AND name='Fictional Builder Two'`)).toEqual([{ n: 1 }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_crm_persons WHERE normalized_colosseum_username='fictional_builder_2'")).toEqual([{ n: 1 }]);
  });
});

describe("refreshing a team's Colosseum snapshot", () => {
  it("updates the snapshot and adds new roster members without touching HQ state", async () => {
    const id = await importProject();
    const team = await store.team(OWNER.id, id);
    const teammate = team.members.find(member => member.username === "fictional_builder_2")!;
    const code = await store.createInvite(OWNER.id, id, teammate.id);
    await store.redeemInvite(TEAMMATE, code);
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

    const refreshed = await store.team(OWNER.id, id);
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
    const team = await store.team(OWNER.id, id);
    const teammate = team.members.find(member => member.username === "fictional_builder_2")!;
    await store.redeemInvite(TEAMMATE, await store.createInvite(OWNER.id, id, teammate.id));
    await store.refreshTeam({ projectId: id, hackathonId: 41, project: { ...PROJECT, members: [PROJECT.members[0]] } });
    const refreshed = await store.team(OWNER.id, id);
    expect(refreshed.members.map(member => member.username)).toEqual(["fictional_builder_1", "fictional_builder_2"]);
    expect((await store.teams(TEAMMATE.id)).map(item => item.id)).toEqual([id]);
  });

  it("is idempotent: the same response applied twice changes nothing", async () => {
    const id = await importProject();
    await store.refreshTeam({ projectId: id, hackathonId: 41, project: PROJECT });
    const first = await rows("SELECT id,name,colosseum_username,person_id FROM hq_project_members WHERE project_id=$1 ORDER BY sort", [id]);
    await store.refreshTeam({ projectId: id, hackathonId: 41, project: PROJECT });
    expect(await rows("SELECT id,name,colosseum_username,person_id FROM hq_project_members WHERE project_id=$1 ORDER BY sort", [id])).toEqual(first);
    expect(await rows("SELECT count(*)::int AS n FROM hq_people WHERE hackathon_id=41")).toEqual([{ n: 5 }]);
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

describe("roster invitations and team access", () => {
  it("only lets the team's own importer create a join link, and only for an unclaimed seat", async () => {
    const id = await importProject();
    const team = await store.team(OWNER.id, id);
    await expect(store.createInvite(OUTSIDER.id, id, team.members[1].id)).rejects.toThrow();
    await expect(store.createInvite(OWNER.id, id, "00000000-0000-4000-8000-000000000001")).rejects.toThrow();
    expect(await rows("SELECT count(*)::int AS n FROM hq_team_invites")).toEqual([{ n: 0 }]);
    // Every unclaimed seat gets one, including the importer's own: a
    // self-service import claims no roster seat, so the importer opens their
    // own link to take theirs.
    await store.createInvite(OWNER.id, id, team.members[0].id);
    await store.createInvite(OWNER.id, id, team.members[1].id);
    expect(await rows("SELECT count(*)::int AS n FROM hq_team_invites")).toEqual([{ n: 2 }]);
  });

  it("accepts a whole pasted join link, a bare code and a link with a tracking query or trailing slash", async () => {
    const item = await invite();
    const path = joinLink(item.code.replaceAll("-", ""));
    for (const pasted of [
      item.code,
      `  ${item.code}  `,
      `https://hq.example.test${path}`,
      `https://hq.example.test${path}/`,
      `https://hq.example.test${path}?utm_source=telegram`,
      `https://hq.example.test${path}#fragment`,
    ]) {
      expect(parseJoinCode(pasted), pasted).not.toBeNull();
      expect(await store.invitation(parseJoinCode(pasted)!), pasted).toMatchObject({ ok: true });
    }
    expect(parseJoinCode("https://hq.example.test/hq/join/not-a-code")).toBeNull();
    expect(parseJoinCode("")).toBeNull();
  });

  it("stores a code hash, shows the intended profile, and revokes previous unconsumed codes", async () => {
    const item = await invite();
    expect(await store.invitation(item.code)).toMatchObject({ ok: true, data: { username: "fictional_builder_2", projectName: "Tulip Ledger", hackathonId: 41 } });
    const [{ token_hash }] = await rows("SELECT token_hash FROM hq_team_invites");
    expect(token_hash).not.toBe(item.code.replaceAll("-", ""));
    expect(String(token_hash)).toMatch(/^[a-f0-9]{64}$/);
    const replacement = await store.createInvite(OWNER.id, item.projectId, item.memberId);
    // A retired link is simply not a link we know: the refusal names nothing about the team.
    expect(await store.invitation(item.code)).toEqual({ ok: false, reason: "invalid" });
    expect(await store.invitation(replacement.toLowerCase().replaceAll("-", " "))).toMatchObject({ ok: true, data: { memberId: item.memberId } });
  });

  it("redeems once, records joined status and adds the teammate to the edition's People", async () => {
    const item = await invite();
    expect(await store.redeemInvite(TEAMMATE, item.code)).toBe(item.projectId);
    // Only the seat the link was for: a self-service import claims none, so
    // the other roster row is still unclaimed after this redemption.
    expect((await store.team(TEAMMATE.id, item.projectId)).members.map(member => member.joined)).toEqual([false, true]);
    expect(await rows("SELECT builder_user_id,joined_at IS NOT NULL AS joined FROM hq_project_members WHERE id=$1", [item.memberId]))
      .toEqual([{ builder_user_id: TEAMMATE.id, joined: true }]);
    expect(await rows("SELECT consumed_by,consumed_at IS NOT NULL AS consumed FROM hq_team_invites")).toEqual([{ consumed_by: TEAMMATE.id, consumed: true }]);
    await expect(store.redeemInvite(OUTSIDER, item.code)).rejects.toThrow("no longer usable");
    expect(await store.invitation(item.code)).toEqual({ ok: false, reason: "used" });
  });

  it("permits only one successful concurrent redemption", async () => {
    const item = await invite();
    const result = await Promise.allSettled([store.redeemInvite(TEAMMATE, item.code), store.redeemInvite(OUTSIDER, item.code)]);
    expect(result.filter(value => value.status === "fulfilled")).toHaveLength(1);
    const [{ builder_user_id }] = await rows("SELECT builder_user_id FROM hq_project_members WHERE id=$1", [item.memberId]);
    expect([TEAMMATE.id, OUTSIDER.id]).toContain(builder_user_id);
    expect(await rows("SELECT count(*)::int AS n FROM hq_team_invites WHERE consumed_at IS NOT NULL")).toEqual([{ n: 1 }]);
  });

  // One distinct reason per refusal, and not one of them names the team.
  it.each([
    ["expired", "expired", "UPDATE hq_team_invites SET expires_at=now()-interval '1 second'"],
    ["a team no longer in an active edition", "other_edition", "UPDATE hq_project_onboarding SET verification='rejected'"],
    ["an archived edition", "other_edition", "UPDATE hq_hackathons SET archived_at=now() WHERE id=41"],
  ])("refuses %s with its own reason, naming nothing about the team", async (_label, reason, change) => {
    const item = await invite();
    await db.query(change);
    const lookup = await store.invitation(item.code);
    expect(lookup).toEqual({ ok: false, reason });
    expect(JSON.stringify(lookup)).not.toContain("Tulip Ledger");
    expect(JOIN_LINK_MESSAGES[reason as keyof typeof JOIN_LINK_MESSAGES]).not.toContain("Tulip Ledger");
    await expect(store.redeemInvite(TEAMMATE, item.code)).rejects.toThrow();
    expect(await rows("SELECT builder_user_id FROM hq_project_members WHERE id=$1", [item.memberId])).toEqual([{ builder_user_id: null }]);
  });

  it("refuses a code that was never issued, without a database row to read", async () => {
    expect(await store.invitation("AAAAAA-BBBBBB-CCCCCC-DDDDDD")).toEqual({ ok: false, reason: "invalid" });
  });

  it("does not let one HQ account claim two seats on the same team", async () => {
    const item = await invite();
    await store.redeemInvite(TEAMMATE, item.code);
    const other = (await store.team(OWNER.id, item.projectId)).members.find(member => member.username === "fictional_builder_1")!;
    const second = await store.createInvite(OWNER.id, item.projectId, other.id);
    await expect(store.redeemInvite(TEAMMATE, second)).rejects.toThrow();
    expect(await rows("SELECT builder_user_id FROM hq_project_members WHERE id=$1", [other.id])).toEqual([{ builder_user_id: null }]);
  });

  it("merges the roster person into the joining account's own person", async () => {
    const item = await invite();
    const [{ id: rosterPerson }] = await rows("SELECT person_id AS id FROM hq_project_members WHERE id=$1", [item.memberId]);
    await store.redeemInvite(TEAMMATE, item.code);
    // The merge branch of correctPersonMatch: the provisional person is gone,
    // its username moved to the account's own person, the roster row follows.
    expect(await rows("SELECT count(*)::int AS n FROM hq_crm_persons WHERE id=$1", [rosterPerson])).toEqual([{ n: 0 }]);
    expect(await rows("SELECT normalized_colosseum_username FROM hq_crm_persons WHERE builder_user_id=$1", [TEAMMATE.id]))
      .toEqual([{ normalized_colosseum_username: "fictional_builder_2" }]);
    expect(await rows(`SELECT person_id=(SELECT id FROM hq_crm_persons WHERE builder_user_id=$2) AS matches
      FROM hq_project_members WHERE id=$1`, [item.memberId, TEAMMATE.id])).toEqual([{ matches: true }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_audit_events WHERE kind='person.match_corrected'")).toEqual([{ n: 1 }]);
  });

  it("scopes team reads and changes to the authenticated owner or joined teammates", async () => {
    const item = await invite();
    expect(await store.teams(OUTSIDER.id)).toEqual([]);
    await expect(store.team(OUTSIDER.id, item.projectId)).rejects.toThrow("your account");
    await expect(store.updateTeam(OUTSIDER.id, item.projectId, "live", "fictional_builder_1")).rejects.toThrow();
    await store.redeemInvite(TEAMMATE, item.code);
    expect(await store.team(TEAMMATE.id, item.projectId)).toMatchObject({ id: item.projectId });
    await expect(store.updateTeam(TEAMMATE.id, item.projectId, "live", "fictional_builder_1")).rejects.toThrow();
    await expect(store.updateTeam(OWNER.id, item.projectId, "live", "outsider")).rejects.toThrow();
    await store.updateTeam(OWNER.id, item.projectId, "live", "fictional_builder_1");
    expect(await rows("SELECT lead_name FROM hq_projects WHERE id=$1", [item.projectId])).toEqual([{ lead_name: "Fictional Builder One" }]);
    expect(await store.team(OWNER.id, item.projectId)).toMatchObject({ stage: "live", leadUsername: "fictional_builder_1" });
  });

  it.each(["pending", "rejected"])("refuses a team change on a %s claim, the way the decision that gates it does", async state => {
    const item = await invite();
    await db.query("UPDATE hq_project_onboarding SET verification=$1 WHERE project_id=$2", [state, item.projectId]);
    await expect(store.updateTeam(OWNER.id, item.projectId, "beta", "fictional_builder_1")).rejects.toThrow("imported team");
    expect(await rows("SELECT stage FROM hq_project_onboarding WHERE project_id=$1", [item.projectId])).toEqual([{ stage: "idea" }]);
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

    await expect(store.redeemInvite(TEAMMATE, item.code)).rejects.toThrow("You currently hold the Captain role for this project");
    // Refused, not silently dropped: the seat is still open and the invite still redeemable once the Captain is reassigned.
    expect(await rows("SELECT builder_user_id FROM hq_project_members WHERE id=$1", [item.memberId])).toEqual([{ builder_user_id: null }]);
    expect(await rows("SELECT consumed_at FROM hq_team_invites WHERE member_id=$1", [item.memberId])).toEqual([{ consumed_at: null }]);
  });

  it("ordering 2 (membership first): a team member who already joined a project cannot then be assigned as its Captain", async () => {
    await seedOperator();
    const item = await invite();
    await grantCaptain(TEAMMATE.id);
    expect(await store.redeemInvite(TEAMMATE, item.code)).toBe(item.projectId);

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

    await expect(store.importTeam(OUTSIDER, { hackathonId: 41, project: PROJECT, projectUrl: PROJECT_URL }))
      .rejects.toMatchObject({ reason: "already_imported" });
    expect(await rows("SELECT owner_user_id FROM hq_project_onboarding WHERE project_id=$1", [id])).toEqual([{ owner_user_id: OWNER.id }]);
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

  it("keeps the Request help route usable when Colosseum cannot be fetched at all", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("Colosseum is offline"));
    vi.stubGlobal("fetch", fetcher);
    expect(await requestBuilderReview({ hackathonId: 41, url: PROJECT_URL, note: "My project does not load on Colosseum yet." }))
      .toEqual({ ok: true, data: { url: "/hq/dashboard" } });
    // The route parses the link locally and records the request; it never
    // depends on the source being reachable, which is the whole point of it.
    expect(fetcher).not.toHaveBeenCalled();
    expect((await store.dashboard(OWNER.id)).requests).toHaveLength(1);
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 0 }]);
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
    expect(await importBuilderTeam({ hackathonId: 41, url: PROJECT_URL })).toMatchObject({ ok: false, reason: "not_found", retry: false });

    vi.stubGlobal("fetch", vi.fn(async () => respond({ message: "slow down", code: "RATE_LIMITED" }, 429)));
    expect(await importBuilderTeam({ hackathonId: 41, url: PROJECT_URL })).toMatchObject({ ok: false, reason: "rate_limited", retry: true });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{broken", { headers: { "Content-Type": "application/json" } })));
    expect(await importBuilderTeam({ hackathonId: 41, url: PROJECT_URL })).toMatchObject({ ok: false, reason: "unreadable", retry: true });

    vi.stubGlobal("fetch", vi.fn(async () => respond({ ...detailBody, project: { ...detailBody.project, country: "Belgium" } })));
    expect(await importBuilderTeam({ hackathonId: 41, url: PROJECT_URL })).toMatchObject({ ok: false, reason: "not_dutch", retry: false });

    vi.stubGlobal("fetch", vi.fn(async () => respond({ ...detailBody, project: { ...detailBody.project, hackathonId: 7, hackathon: { id: 7, slug: "next-edition", name: "Next" } } })));
    expect(await importBuilderTeam({ hackathonId: 41, url: PROJECT_URL })).toMatchObject({ ok: false, reason: "wrong_edition", retry: false });

    expect(await importBuilderTeam({ hackathonId: 41, url: "https://example.com/not-colosseum" })).toMatchObject({ ok: false, reason: "invalid_url" });

    const calls = vi.fn(async () => respond(detailBody));
    vi.stubGlobal("fetch", calls);
    const imported = await importBuilderTeam({ hackathonId: 41, url: PROJECT_URL });
    expect(imported.ok).toBe(true);
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 1 }]);

    // The distinct outcome the plan singles out: already imported, routed to
    // help rather than to a retry, revealing nothing about who owns it.
    const second = await importBuilderTeam({ hackathonId: 41, url: PROJECT_URL });
    expect(second).toMatchObject({ ok: false, reason: "already_imported", retry: false });
    expect("error" in second && second.error).not.toContain(OWNER.name);

    expect(await rows("SELECT kind,actor_kind FROM hq_audit_events WHERE kind='project.imported'"))
      .toEqual([{ kind: "project.imported", actor_kind: "member" }]);
  });
});
