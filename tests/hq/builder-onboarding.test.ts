import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportedProject } from "@/lib/colosseum-api";
import { BuilderStore, type BuilderDatabase } from "@/lib/hq/builder-store";
import * as builderModule from "@/lib/hq/builder-store";
import type { BuilderIdentity } from "@/lib/hq/builder-types";
import { correctPersonMatch, ensurePersonForRosterMember, linkPersonToAccount, normalizeColosseumUsername } from "@/lib/hq/crm-identity";
import { applyUpgrades } from "@/scripts/hq/upgrades";
import { pgliteBuilderDatabase } from "./helpers/db";

vi.mock("server-only", () => ({}));
const actionMocks = vi.hoisted(() => ({ requireMember: vi.fn() }));
vi.mock("@/lib/hq/member-auth", () => ({ requireMember: actionMocks.requireMember }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { chooseBuilderPath, completeBuilderImport, requestBuilderReview } from "@/lib/hq/actions/builders";

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
  hackathon: { id: 6, slug: "frontier", name: "Frontier" },
  members: [
    { username: "fictional_builder_1", displayName: "Fictional Builder One", avatarUrl: null },
    { username: "fictional_builder_2", displayName: "Fictional Builder Two", avatarUrl: null },
  ],
  description: "An imported project description.",
  links: { repoLink: "https://github.com/example/project", website: null, presentationLink: null,
    technicalDemoLink: null, pitchVideoLink: null, demoVideoLink: null },
  imageUrl: null,
  raw: { projectType: "HACKATHON", project: { id: 90001, hackathonId: 6, slug: "tulip-ledger" } },
};
const PROOF = { commentId: 9001, authorId: 1234, username: "fictional_builder_1" };

let pg: PGlite;
let db: BuilderDatabase;
let store: BuilderStore;

async function rows(text: string, values?: unknown[]) { return (await db.query(text, values)).rows; }

async function prepareUsers() {
  await Promise.all([OWNER, TEAMMATE, OUTSIDER].map(user => store.syncAccount(user)));
}

async function importProject(verified = true, project = PROJECT, owner = OWNER, hackathonId = 41) {
  const challenge = await store.issueChallenge(owner, hackathonId, project, "fictional_builder_1");
  const id = await store.importTeam(owner, challenge.id, project, "fictional_builder_2", "mvp", verified ? PROOF : null);
  return { id, challenge };
}

async function invite() {
  const { id } = await importProject();
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
    expect(await events()).toEqual([expect.objectContaining({
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

describe("project challenges and CRM import", () => {
  it("scopes challenge lookup to its owner and lifetime", async () => {
    const challenge = await store.issueChallenge(OWNER, 41, PROJECT, "fictional_builder_1");
    expect(await store.challenge(OWNER.id, challenge.id)).toMatchObject({ externalId: 90001, hackathonId: 41, username: "fictional_builder_1" });
    await expect(store.challenge(OUTSIDER.id, challenge.id)).rejects.toThrow("expired");
    await db.query("UPDATE hq_project_challenges SET expires_at=now()-interval '1 second' WHERE id=$1", [challenge.id]);
    await expect(store.challenge(OWNER.id, challenge.id)).rejects.toThrow("expired");
  });

  it("imports project, chosen lead, stage, raw data and all teammates together", async () => {
    const { id, challenge } = await importProject();
    expect(await rows(`SELECT p.name,p.lead_name,p.hackathon_id,o.stage,o.verification,o.country,o.raw,
      o.proof_comment_id::int,o.proof_author_id::int FROM hq_projects p JOIN hq_project_onboarding o ON o.project_id=p.id WHERE p.id=$1`, [id]))
      .toEqual([{ name: "Tulip Ledger", lead_name: "Fictional Builder Two", hackathon_id: 41, stage: "mvp", verification: "verified", country: "Netherlands",
        raw: PROJECT.raw, proof_comment_id: PROOF.commentId, proof_author_id: PROOF.authorId }]);
    expect(await rows(`SELECT name,colosseum_username,builder_user_id,joined_at IS NOT NULL AS joined
      FROM hq_project_members WHERE project_id=$1 ORDER BY sort`, [id])).toEqual([
      { name: "Fictional Builder One", colosseum_username: "fictional_builder_1", builder_user_id: OWNER.id, joined: true },
      { name: "Fictional Builder Two", colosseum_username: "fictional_builder_2", builder_user_id: null, joined: false },
    ]);
    expect(await rows("SELECT consumed_at IS NOT NULL AS consumed FROM hq_project_challenges WHERE id=$1", [challenge.id])).toEqual([{ consumed: true }]);
    await expect(store.importTeam(OWNER, challenge.id, PROJECT, "fictional_builder_2", "mvp", PROOF)).rejects.toThrow("already been used");
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 1 }]);
  });

  it("does not let another account consume a project challenge", async () => {
    const challenge = await store.issueChallenge(OWNER, 41, PROJECT, "fictional_builder_1");
    await expect(store.importTeam(OUTSIDER, challenge.id, PROJECT, "fictional_builder_2", "mvp", PROOF)).rejects.toThrow();
    expect(await store.challenge(OWNER.id, challenge.id)).toMatchObject({ id: challenge.id });
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 0 }]);
  });

  it.each([
    { project: { ...PROJECT, country: "Belgium" }, proof: PROOF },
    { project: { ...PROJECT, country: null }, proof: PROOF },
    { project: PROJECT, proof: { ...PROOF, username: "fictional_builder_2" } },
    { project: { ...PROJECT, hackathon: { id: 7, slug: "frontier", name: "Different" } }, proof: PROOF },
    { project: { ...PROJECT, hackathon: { id: 6, slug: "different", name: "Different" } }, proof: PROOF },
    { project: { ...PROJECT, externalId: 8099 }, proof: PROOF },
  ])("rolls back a challenge and all CRM writes for invalid identity/country/config %#", async ({ project, proof }) => {
    const challenge = await store.issueChallenge(OWNER, 41, PROJECT, "fictional_builder_1");
    await expect(store.importTeam(OWNER, challenge.id, project, "fictional_builder_2", "idea", proof)).rejects.toThrow();
    expect(await rows("SELECT consumed_at FROM hq_project_challenges WHERE id=$1", [challenge.id])).toEqual([{ consumed_at: null }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_activity")).toEqual([{ n: 0 }]);
  });

  it("rolls back the entire import if its activity write fails", async () => {
    const challenge = await store.issueChallenge(OWNER, 41, PROJECT, "fictional_builder_1");
    await db.query("ALTER TABLE hq_activity ADD CONSTRAINT test_activity_failure CHECK (message='')");
    try {
      await expect(store.importTeam(OWNER, challenge.id, PROJECT, "fictional_builder_2", "mvp", PROOF)).rejects.toThrow();
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
    const current = { ...PROJECT, name: "Tulip Ledger updated", description: "Current project details", raw: { snapshot: "current" } };
    const challenge = await store.issueChallenge(OWNER, 41, current, "fictional_builder_1");
    const recovered = await store.importTeam(OWNER, challenge.id, current, "fictional_builder_2", "beta", PROOF);
    expect(recovered).toBe(id);
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 1 }]);
    expect(await store.teams(OUTSIDER.id)).toEqual([]);
    await expect(store.team(OUTSIDER.id, id)).rejects.toThrow("your account");
    expect(await store.team(OWNER.id, id)).toMatchObject({ ownerId: OWNER.id, verification: "verified", stage: "beta", name: "Tulip Ledger updated" });
    expect(await rows("SELECT colosseum_username,builder_user_id,joined_at IS NOT NULL AS joined FROM hq_project_members WHERE project_id=$1 ORDER BY sort", [id])).toEqual([
      { colosseum_username: "fictional_builder_1", builder_user_id: OWNER.id, joined: true },
      { colosseum_username: "fictional_builder_2", builder_user_id: null, joined: false },
    ]);
    expect(await rows("SELECT high_potential,raw FROM hq_project_onboarding WHERE project_id=$1", [id])).toEqual([{ high_potential: true, raw: current.raw }]);
    expect(await rows("SELECT body FROM hq_project_notes WHERE project_id=$1", [id])).toEqual([{ body: "Keep this operator review history" }]);
  });

  it("updates the current Colosseum link and slug when recovering the same external project", async () => {
    const { id } = await importProject(false, PROJECT, OUTSIDER);
    const current = { ...PROJECT, slug: "tulip-ledger-current" };
    const challenge = await store.issueChallenge(OWNER, 41, current, "fictional_builder_1");
    expect(await store.importTeam(OWNER, challenge.id, current, "fictional_builder_2", "mvp", PROOF)).toBe(id);
    expect(await rows("SELECT slug,project_url FROM hq_project_onboarding WHERE project_id=$1", [id])).toEqual([
      { slug: current.slug, project_url: `https://colosseum.com/arena/projects/explore/${current.slug}` },
    ]);
  });

  it.each(["pending", "rejected"])("does not let a second unverified claimant replace a %s claim", async (state) => {
    const { id } = await importProject(false);
    if (state === "rejected") await db.query("UPDATE hq_project_onboarding SET verification='rejected' WHERE project_id=$1", [id]);
    const challenge = await store.issueChallenge(OUTSIDER, 41, PROJECT, "fictional_builder_1");
    await expect(store.importTeam(OUTSIDER, challenge.id, PROJECT, "fictional_builder_2", "idea", null)).rejects.toThrow("awaiting review");
    expect(await store.challenge(OUTSIDER.id, challenge.id)).toMatchObject({ id: challenge.id });
    expect(await rows("SELECT owner_user_id,verification FROM hq_project_onboarding WHERE project_id=$1", [id])).toEqual([{ owner_user_id: OWNER.id, verification: state }]);
    expect(await store.teams(OUTSIDER.id)).toEqual([]);
  });

  it("never replaces an already verified team even with an earlier valid challenge", async () => {
    const challenge = await store.issueChallenge(OUTSIDER, 41, PROJECT, "fictional_builder_1");
    const { id } = await importProject();
    await expect(store.issueChallenge(OUTSIDER, 41, PROJECT, "fictional_builder_1")).rejects.toThrow("already in HQ");
    await expect(store.importTeam(OUTSIDER, challenge.id, PROJECT, "fictional_builder_2", "live", PROOF)).rejects.toThrow("already verified");
    expect(await rows("SELECT owner_user_id,verification FROM hq_project_onboarding WHERE project_id=$1", [id])).toEqual([{ owner_user_id: OWNER.id, verification: "verified" }]);
    expect(await store.challenge(OUTSIDER.id, challenge.id)).toMatchObject({ id: challenge.id });
  });

  it("revokes all old claim invites and joined identities on recovery", async () => {
    const { id } = await importProject(true, PROJECT, OUTSIDER);
    const teammate = (await store.team(OUTSIDER.id, id)).members.find(member => member.username === "fictional_builder_2")!;
    const code = await store.createInvite(OUTSIDER.id, id, teammate.id);
    await store.redeemInvite(TEAMMATE, code);
    await db.query("UPDATE hq_project_onboarding SET verification='rejected' WHERE project_id=$1", [id]);
    const challenge = await store.issueChallenge(OWNER, 41, PROJECT, "fictional_builder_1");
    await store.importTeam(OWNER, challenge.id, PROJECT, "fictional_builder_2", "mvp", PROOF);
    expect(await store.teams(OUTSIDER.id)).toEqual([]);
    expect(await store.teams(TEAMMATE.id)).toEqual([]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_team_invites WHERE project_id=$1", [id])).toEqual([{ n: 0 }]);
    await expect(store.invitation(code)).rejects.toThrow("invalid, expired");
    expect((await store.team(OWNER.id, id)).members.find(member => member.username === "fictional_builder_2")?.joined).toBe(false);
  });

  it("rolls back ownership and roster replacement if recovery cannot be fully committed", async () => {
    const { id } = await importProject(false, PROJECT, OUTSIDER);
    const roster = await rows("SELECT id,colosseum_username,builder_user_id FROM hq_project_members WHERE project_id=$1 ORDER BY sort", [id]);
    const challenge = await store.issueChallenge(OWNER, 41, PROJECT, "fictional_builder_1");
    await db.query("ALTER TABLE hq_activity ADD CONSTRAINT test_recovery_failure CHECK (message NOT LIKE '%and verified%')");
    try {
      await expect(store.importTeam(OWNER, challenge.id, PROJECT, "fictional_builder_2", "mvp", PROOF)).rejects.toThrow();
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
    const challenge = await store.issueChallenge(OWNER, 41, PROJECT, "fictional_builder_1");
    await db.query(`UPDATE hq_hackathon_onboarding SET ${change} WHERE hackathon_id=41`);
    await expect(store.importTeam(OWNER, challenge.id, PROJECT, "fictional_builder_2", "idea", proof)).rejects.toThrow("imports are not open");
    expect(await rows("SELECT consumed_at FROM hq_project_challenges WHERE id=$1", [challenge.id])).toEqual([{ consumed_at: null }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 0 }]);
  });

  it("never imports a duplicate external project twice when two challenges race", async () => {
    const a = await store.issueChallenge(OWNER, 41, PROJECT, "fictional_builder_1");
    const b = await store.issueChallenge(OUTSIDER, 41, PROJECT, "fictional_builder_1");
    const result = await Promise.allSettled([
      store.importTeam(OWNER, a.id, PROJECT, "fictional_builder_2", "mvp", PROOF),
      store.importTeam(OUTSIDER, b.id, PROJECT, "fictional_builder_2", "idea", PROOF),
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
    expect(await store.invitation(item.code)).toMatchObject({ username: "fictional_builder_2", projectName: "Tulip Ledger", hackathonId: 41 });
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
    expect(await rows("SELECT stage FROM hq_project_onboarding WHERE project_id=$1", [item.projectId])).toEqual([{ stage: "mvp" }]);
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
    const challenge = await store.issueChallenge(OWNER, 41, PROJECT, "fictional_builder_1");
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
    const challenge = await store.issueChallenge(OWNER, 41, PROJECT, "fictional_builder_1");
    let projectReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      const json = url.pathname.endsWith("/comments") ? {
        comments: [{ id: 9001, projectId: PROJECT.externalId, user: { id: 1234, username: "fictional_builder_1" },
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
    expect(await completeBuilderImport({ challengeId: challenge.id, leadUsername: "fictional_builder_2", stage: "mvp", manual: false })).toMatchObject({ ok: false });
    expect(projectReads).toBeGreaterThanOrEqual(2);
    expect(await rows("SELECT count(*)::int AS n FROM hq_projects")).toEqual([{ n: 0 }]);
    expect(await store.challenge(OWNER.id, challenge.id)).toMatchObject({ id: challenge.id });
  });
});
