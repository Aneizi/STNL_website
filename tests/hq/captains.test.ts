// The Captain invitation service against the real schema on PGlite: only the
// hash is ever stored, capacity is enforced under a real row lock, the
// idempotence and "no resurrection on replay" rules hold, revocation stops
// only future redemption, and a redemption's capability grant and audit
// event commit or roll back together with its redemption row.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ builderDatabase: vi.fn() }));
vi.mock("@/lib/hq/builder-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hq/builder-db")>()),
  builderDatabase: mocks.builderDatabase,
}));

import {
  acceptCaptainInvitation, assignCaptain, clearCaptainAssignments, countAssignmentsByCaptain, countAssignmentsForCaptain,
  countAssignmentsForUsers, createCaptainInvitation, currentCaptainOfProject, leaderboard, listAssignments, listCaptainInvitations,
  readCaptainInvitationByToken, revokeCaptainInvitation, unassignCaptain,
} from "@/lib/hq/captains";
import { loadTeamMembership } from "@/lib/hq/authz-sql";
import type { BuilderDatabase } from "@/lib/hq/builder-db";
import { grantCapability, revokeCapability } from "@/lib/hq/capabilities";
import { createMigratedDatabase, pgliteBuilderDatabase } from "./helpers/db";

const OPERATOR = "00000000-0000-4000-8000-000000000001";
const SECOND_OPERATOR = "00000000-0000-4000-8000-000000000002";
const EDITION_A = 41;
const EDITION_B = 42;
let pg: PGlite;
let db: BuilderDatabase;
let telegramCounter = 1_000_000;
let projectCounter = 0;

async function rows(text: string, values: unknown[] = []) { return (await pg.query(text, values)).rows as Record<string, unknown>[]; }

/**
 * A verified-by-email, verified-by-Telegram, or deliberately unverified HQ
 * account, plus its hq_builder_profiles row (every service call needs one).
 * `ON CONFLICT DO NOTHING` so a test that both names an account as an
 * assignment's roster owner (seedImportedProject) and separately grants it
 * Captain (seedCaptain) can seed it either way, or both, without a duplicate
 * key error.
 */
async function seedAccount(id: string, verified: "email" | "telegram" | "none" = "email") {
  const email = verified === "email" ? `${id}@example.test` : `${id}@telegram.placeholder.invalid`;
  await rows(`INSERT INTO hq_auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`, [id, id, email, verified === "email"]);
  await rows(`INSERT INTO hq_builder_profiles(id,email,name) VALUES($1,$2,$3) ON CONFLICT (id) DO NOTHING`, [id, verified === "email" ? email : null, id]);
  if (verified === "telegram") {
    telegramCounter += 1;
    await rows(`INSERT INTO hq_auth_telegram_identity(user_id,provider_subject,telegram_user_id,username) VALUES($1,$2,$3,$4)`, [id, `subject-${id}`, telegramCounter, id]);
  }
}

/** An account with an active `captain` grant, seeded plus granted in one call. */
async function seedCaptain(id: string) {
  await seedAccount(id);
  await grantCapability(db, { actor: { kind: "operator", id: OPERATOR }, byOperatorId: OPERATOR, userId: id, capability: "captain", reason: "test" });
}

/** A bare hq_projects row in the given edition — no roster, no onboarding: what an Admin-created project (never imported) looks like. */
async function seedProject(id: string, hackathonId: number = EDITION_A, name = "Project") {
  await rows(
    `INSERT INTO hq_projects(id,hackathon_id,name,status_id,forecast_id,last_check_in)
     SELECT $1,$2,$3,s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f LIMIT 1`,
    [id, hackathonId, name],
  );
}

/**
 * A project imported from Colosseum: the onboarding row plus a roster whose
 * owner is already a linked, verified account. `verification` defaults to
 * 'verified' so `loadTeamMembership` sees the owner; pass 'pending' to test
 * the pre-verification window loadTeamMembership misses on its own.
 */
/**
 * `linkOwnerToRoster` defaults to true (the normal case, where the claimant
 * also matches a roster member's username exactly — `importTeam`'s own
 * link condition). Pass false to model a claimant absent from the imported
 * roster, or case-mismatched against it: `owner_user_id` is set, but no
 * `hq_project_members` row names them at all.
 */
async function seedImportedProject(input: { id: string; hackathonId?: number; ownerUserId: string; verification?: "pending" | "verified" | "rejected"; linkOwnerToRoster?: boolean }) {
  const hackathonId = input.hackathonId ?? EDITION_A;
  await seedAccount(input.ownerUserId);
  await seedProject(input.id, hackathonId, `Imported ${input.ownerUserId}`);
  projectCounter += 1;
  await rows(
    `INSERT INTO hq_project_onboarding(project_id,hackathon_id,external_id,project_url,slug,country,raw,owner_user_id,verification,lead_username)
     VALUES($1,$2,$3,$4,$5,'Netherlands','{}',$6,$7,$6)`,
    [input.id, hackathonId, 90_000 + projectCounter, `https://colosseum.com/arena/projects/explore/${input.ownerUserId}`, `slug-${projectCounter}`, input.ownerUserId, input.verification ?? "verified"],
  );
  if (input.linkOwnerToRoster ?? true) {
    await rows(
      `INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at) VALUES($1,$2,$2,$3,now())`,
      [input.id, input.ownerUserId, input.ownerUserId],
    );
  }
}

/** A joined-and-verified (not owner) roster member on an already-imported project. */
async function joinRoster(projectId: string, memberUserId: string) {
  await rows(
    `INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at) VALUES($1,$2,$2,$3,now())`,
    [projectId, memberUserId, memberUserId],
  );
}

/** An unclaimed roster row with no person at all — today's common case (Phase 3 has not run). */
async function unclaimedRosterRow(projectId: string, name: string, username: string) {
  await rows(`INSERT INTO hq_project_members(project_id,name,colosseum_username) VALUES($1,$2,$3)`, [projectId, name, username]);
}

/** An unclaimed roster row whose CRM person is linked to `candidateUserId` — the "linked imported roster identity" conflict source, independent of verified membership. */
async function rosterLinkedToAccount(projectId: string, name: string, username: string, candidateUserId: string) {
  const [person] = await rows(
    `INSERT INTO hq_crm_persons(display_name,normalized_colosseum_username,builder_user_id) VALUES($1,$2,$3) RETURNING id::text AS id`,
    [name, username, candidateUserId],
  );
  await rows(`INSERT INTO hq_project_members(project_id,name,colosseum_username,person_id) VALUES($1,$2,$3,$4::uuid)`, [projectId, name, username, person.id]);
}

/** An unclaimed roster row with a provisional person (matched by username) that has never been linked to any account. */
async function rosterWithProvisionalPerson(projectId: string, name: string, username: string) {
  const [person] = await rows(`INSERT INTO hq_crm_persons(display_name,normalized_colosseum_username) VALUES($1,$2) RETURNING id::text AS id`, [name, username]);
  await rows(`INSERT INTO hq_project_members(project_id,name,colosseum_username,person_id) VALUES($1,$2,$3,$4::uuid)`, [projectId, name, username, person.id]);
}

async function createInvitation(overrides: Partial<{ actorOperatorId: string; label: string | null; maxRedemptions: number; expiresInDays: number }> = {}) {
  return createCaptainInvitation(db, { actorOperatorId: OPERATOR, maxRedemptions: 1, expiresInDays: 7, ...overrides });
}

const grants = () => rows("SELECT user_id,capability,revoked_at IS NULL AS active FROM hq_account_capabilities ORDER BY granted_at,id");
const redemptions = () => rows("SELECT invitation_id::text AS invitation_id,user_id FROM hq_captain_invitation_redemptions ORDER BY redeemed_at,id");
const events = () => rows("SELECT kind,actor_kind,actor_id,subject_user_id,metadata FROM hq_audit_events ORDER BY id");
/** Just the assignment events, ignoring the capability.granted events seedCaptain's own grantCapability calls also leave behind. */
const assignmentEvents = () => rows("SELECT kind,actor_kind,actor_id,subject_user_id,metadata FROM hq_audit_events WHERE kind IN ('captain.assigned','captain.unassigned') ORDER BY id");
const currentAssignments = () => rows("SELECT project_id::text AS project_id, captain_user_id FROM hq_captain_assignments WHERE unassigned_at IS NULL ORDER BY project_id");

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = pgliteBuilderDatabase(pg);
  mocks.builderDatabase.mockReturnValue(db);
}, 30_000);

beforeEach(async () => {
  await pg.exec(
    `TRUNCATE hq_users, hq_builder_profiles, hq_audit_events, hq_auth_user, hq_auth_telegram_identity, hq_account_capabilities,
       hq_captain_invitations, hq_captain_invitation_redemptions, hq_hackathons, hq_project_statuses, hq_project_forecasts,
       hq_crm_persons
     RESTART IDENTITY CASCADE`,
  );
  await rows("INSERT INTO hq_users(id,username,display_name,password_hash) VALUES($1,'operator','Operator','unused'),($2,'second','Second','unused')", [OPERATOR, SECOND_OPERATOR]);
  await rows(
    "INSERT INTO hq_hackathons(id,slug,name,start_date,end_date) VALUES($1,'edition-a','Edition A','2026-09-14','2026-10-12'),($2,'edition-b','Edition B','2027-01-01','2027-02-01')",
    [EDITION_A, EDITION_B],
  );
  await rows("INSERT INTO hq_project_statuses(slug,label,color,counts_as_active,sort) VALUES('onboarding','Onboarding','accent',true,100)");
  await rows("INSERT INTO hq_project_forecasts(slug,label,color,sort) VALUES('unassessed','Not assessed','muted',100)");
});

afterAll(async () => { await pg.close(); });

describe("createCaptainInvitation", () => {
  it("stores only the hash: no column of any table holds the plaintext token", async () => {
    const { token, invitation } = await createInvitation({ label: "Rotterdam meetup" });
    const invitationRows = await rows("SELECT * FROM hq_captain_invitations");
    const auditRows = await rows("SELECT * FROM hq_audit_events");
    const dump = JSON.stringify([invitationRows, auditRows]);
    expect(dump).not.toContain(token);
    expect(String(invitationRows[0].token_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(invitation).toMatchObject({ label: "Rotterdam meetup", maxRedemptions: 1, usedCount: 0, state: "active", createdByUserId: OPERATOR, createdByName: "Operator" });
    expect(await events()).toEqual([
      { kind: "captain.invitation_created", actor_kind: "operator", actor_id: OPERATOR, subject_user_id: null, metadata: { invitationId: invitation.id, maxRedemptions: 1, label: "Rotterdam meetup" } },
    ]);
  });

  it("defaults capability to captain and validates maxRedemptions and expiry", async () => {
    await expect(createInvitation({ maxRedemptions: 0 })).rejects.toThrow(/whole number/);
    await expect(createInvitation({ maxRedemptions: 1.5 })).rejects.toThrow(/whole number/);
    await expect(createInvitation({ maxRedemptions: 501 })).rejects.toThrow(/whole number/);
    await expect(createInvitation({ maxRedemptions: 500 })).resolves.toMatchObject({ invitation: { maxRedemptions: 500 } });
    await expect(createInvitation({ expiresInDays: -1 })).rejects.toThrow(/future/);
    await expect(createCaptainInvitation(db, { actorOperatorId: OPERATOR, maxRedemptions: 1, expiresAt: "not-a-date" })).rejects.toThrow(/valid expiry/);
    await expect(createCaptainInvitation(db, { actorOperatorId: OPERATOR, maxRedemptions: 1, expiresAt: new Date(Date.now() - 1000).toISOString() })).rejects.toThrow(/future/);
  });
});

describe("readCaptainInvitationByToken", () => {
  it("returns redeemability only — never the token, the creator, or a redeemer list", async () => {
    await seedAccount("acct-a");
    const { token, invitation } = await createInvitation({ label: "Utrecht cohort", maxRedemptions: 1 });
    const before = await readCaptainInvitationByToken(db, token);
    expect(before).toEqual({ id: invitation.id, capability: "captain", label: "Utrecht cohort", expiresAt: invitation.expiresAt, expired: false, revoked: false, full: false });
    expect(Object.keys(before!).sort()).toEqual(["capability", "expired", "expiresAt", "full", "id", "label", "revoked"]);

    await acceptCaptainInvitation(db, { invitationId: invitation.id, userId: "acct-a" });
    const after = await readCaptainInvitationByToken(db, token);
    expect(after).toMatchObject({ full: true });
    expect(JSON.stringify(after)).not.toContain(token);
    expect(JSON.stringify(after)).not.toContain("acct-a");
    expect(JSON.stringify(after)).not.toContain(OPERATOR);
  });

  it("returns null for an unknown token, and consumes nothing", async () => {
    expect(await readCaptainInvitationByToken(db, "unknown-token")).toBeNull();
    expect(await redemptions()).toEqual([]);
  });

  it("changes nothing when read twice in a row — modelling a link preview immediately followed by a real visit", async () => {
    const { token, invitation } = await createInvitation({ maxRedemptions: 2 });
    const first = await readCaptainInvitationByToken(db, token);
    const second = await readCaptainInvitationByToken(db, token);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ id: invitation.id, full: false });
    expect(await redemptions()).toEqual([]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_captain_invitations")).toEqual([{ n: 1 }]);
  });
});

describe("acceptCaptainInvitation", () => {
  it("refuses an unverified account without touching anything", async () => {
    await seedAccount("acct-unverified", "none");
    const { invitation } = await createInvitation();
    expect(await acceptCaptainInvitation(db, { invitationId: invitation.id, userId: "acct-unverified" })).toEqual({ outcome: "unverified" });
    expect(await grants()).toEqual([]);
    expect(await redemptions()).toEqual([]);
    expect(await events()).toHaveLength(1); // only invitation_created
  });

  it("accepts a Telegram-verified account exactly like an email-verified one", async () => {
    await seedAccount("acct-tg", "telegram");
    const { invitation } = await createInvitation();
    expect(await acceptCaptainInvitation(db, { invitationId: invitation.id, userId: "acct-tg" })).toEqual({ outcome: "granted" });
    expect(await grants()).toEqual([{ user_id: "acct-tg", capability: "captain", active: true }]);
  });

  it("returns not-found for an unknown invitation id", async () => {
    await seedAccount("acct-a");
    expect(await acceptCaptainInvitation(db, { invitationId: "00000000-0000-4000-8000-0000000000aa", userId: "acct-a" })).toEqual({ outcome: "not-found" });
  });

  it("returns a typed outcome for a verified account whose builder profile has not synced yet, instead of an unhandled foreign-key error", async () => {
    // Verified in hq_auth_user (isVerifiedForRedemption passes) but no
    // hq_builder_profiles row: the narrow pre-sync window the redemption
    // insert's foreign key and grantCapability both depend on.
    await rows(`INSERT INTO hq_auth_user(id,name,email,"emailVerified") VALUES('acct-no-profile','No Profile','acct-no-profile@example.test',true)`);
    const { invitation } = await createInvitation();
    expect(await acceptCaptainInvitation(db, { invitationId: invitation.id, userId: "acct-no-profile" })).toEqual({ outcome: "no-profile" });
    expect(await redemptions()).toEqual([]);
    expect(await grants()).toEqual([]);
  });

  it("a one-use link: the first acceptance grants, a second distinct account is refused as full", async () => {
    await seedAccount("acct-a");
    await seedAccount("acct-b");
    const { invitation } = await createInvitation({ maxRedemptions: 1 });
    expect(await acceptCaptainInvitation(db, { invitationId: invitation.id, userId: "acct-a" })).toEqual({ outcome: "granted" });
    expect(await acceptCaptainInvitation(db, { invitationId: invitation.id, userId: "acct-b" })).toEqual({ outcome: "full" });
    expect(await grants()).toEqual([{ user_id: "acct-a", capability: "captain", active: true }]);
    expect(await redemptions()).toEqual([{ invitation_id: invitation.id, user_id: "acct-a" }]);
  });

  it("a multi-use link honours its exact capacity", async () => {
    for (const id of ["acct-a", "acct-b", "acct-c", "acct-d"]) await seedAccount(id);
    const { invitation } = await createInvitation({ maxRedemptions: 3 });
    const outcomes = [];
    for (const id of ["acct-a", "acct-b", "acct-c", "acct-d"]) {
      outcomes.push((await acceptCaptainInvitation(db, { invitationId: invitation.id, userId: id })).outcome);
    }
    expect(outcomes).toEqual(["granted", "granted", "granted", "full"]);
    expect(await redemptions()).toHaveLength(3);
  });

  it("overlapping acceptance calls never exceed capacity, however many arrive at once", async () => {
    // What this actually proves: the capacity arithmetic is correct across
    // several simultaneous callers, however many "granted" outcomes land.
    // It does NOT prove the FOR UPDATE lock is what keeps that true.
    // pgliteBuilderDatabase (tests/hq/helpers/db.ts) funnels every query and
    // every transaction through one promise queue on PGlite's single
    // connection, so these five Promise.all calls run as five strictly
    // sequential transactions, never truly interleaved — the same
    // { granted: 2, full: 3 } result would come back even with FOR UPDATE
    // deleted from the query. The row lock's own presence is guarded
    // separately, by the source-level test right below, since this harness
    // cannot exercise real concurrency to prove it.
    for (const id of ["acct-a", "acct-b", "acct-c", "acct-d", "acct-e"]) await seedAccount(id);
    const { invitation } = await createInvitation({ maxRedemptions: 2 });
    const results = await Promise.all(
      ["acct-a", "acct-b", "acct-c", "acct-d", "acct-e"].map((id) => acceptCaptainInvitation(db, { invitationId: invitation.id, userId: id })),
    );
    const outcomeCounts = results.reduce<Record<string, number>>((counts, r) => ({ ...counts, [r.outcome]: (counts[r.outcome] ?? 0) + 1 }), {});
    expect(outcomeCounts).toEqual({ granted: 2, full: 3 });
    expect(await redemptions()).toHaveLength(2);
    expect((await grants()).filter((g) => g.active)).toHaveLength(2);
  });

  it("locks the invitation row for the whole decision — a regression guard, since PGlite's serialized test pool cannot itself prove concurrency safety", () => {
    const source = readFileSync(join(process.cwd(), "lib/hq/captains.ts"), "utf8");
    expect(source).toMatch(/FROM hq_captain_invitations WHERE id = \$1::uuid FOR UPDATE/);
  });

  it("repeat acceptance by the same account is idempotent and consumes no second slot", async () => {
    await seedAccount("acct-a");
    const { invitation } = await createInvitation({ maxRedemptions: 5 });
    expect(await acceptCaptainInvitation(db, { invitationId: invitation.id, userId: "acct-a" })).toEqual({ outcome: "granted" });
    expect(await acceptCaptainInvitation(db, { invitationId: invitation.id, userId: "acct-a" })).toEqual({ outcome: "already-redeemed" });
    expect(await acceptCaptainInvitation(db, { invitationId: invitation.id, userId: "acct-a" })).toEqual({ outcome: "already-redeemed" });
    expect(await redemptions()).toEqual([{ invitation_id: invitation.id, user_id: "acct-a" }]);
    expect(await events()).toHaveLength(3); // invitation_created, capability.granted, captain.invitation_redeemed — no repeats
  });

  it("a replay after an admin revoked that account's grant does not re-grant it", async () => {
    await seedAccount("acct-a");
    const { invitation } = await createInvitation();
    expect(await acceptCaptainInvitation(db, { invitationId: invitation.id, userId: "acct-a" })).toEqual({ outcome: "granted" });
    await rows("UPDATE hq_account_capabilities SET revoked_at = now(), revoked_by_user_id = $1 WHERE user_id = 'acct-a'", [SECOND_OPERATOR]);
    expect(await acceptCaptainInvitation(db, { invitationId: invitation.id, userId: "acct-a" })).toEqual({ outcome: "already-redeemed" });
    expect(await grants()).toEqual([{ user_id: "acct-a", capability: "captain", active: false }]);
    expect((await events()).map((e) => e.kind)).toEqual(["captain.invitation_created", "capability.granted", "captain.invitation_redeemed"]);
  });

  it("an account that already holds Captain from elsewhere does not consume a slot", async () => {
    await seedAccount("acct-a");
    await rows("INSERT INTO hq_account_capabilities(user_id,capability,granted_by_user_id,reason) VALUES('acct-a','captain',$1,'Granted directly in Admin')", [OPERATOR]);
    const { invitation } = await createInvitation({ maxRedemptions: 1 });
    expect(await acceptCaptainInvitation(db, { invitationId: invitation.id, userId: "acct-a" })).toEqual({ outcome: "already-captain" });
    expect(await redemptions()).toEqual([]);
    expect(await grants()).toEqual([{ user_id: "acct-a", capability: "captain", active: true }]);
    // The slot it did not consume is still available to a genuinely new account.
    await seedAccount("acct-b");
    expect(await acceptCaptainInvitation(db, { invitationId: invitation.id, userId: "acct-b" })).toEqual({ outcome: "granted" });
  });

  it("revoked and expired links refuse redemption without touching an existing grant", async () => {
    await seedAccount("acct-a");
    await seedAccount("acct-b");
    const revokedInvite = await createInvitation();
    await acceptCaptainInvitation(db, { invitationId: revokedInvite.invitation.id, userId: "acct-a" });
    await revokeCaptainInvitation(db, { actorOperatorId: OPERATOR, invitationId: revokedInvite.invitation.id });
    // The existing Captain keeps access; a new account is refused.
    expect(await acceptCaptainInvitation(db, { invitationId: revokedInvite.invitation.id, userId: "acct-b" })).toEqual({ outcome: "revoked" });
    expect(await grants()).toEqual([{ user_id: "acct-a", capability: "captain", active: true }]);

    const soonToExpire = await createInvitation();
    await rows("UPDATE hq_captain_invitations SET expires_at = now() - interval '1 minute' WHERE id = $1::uuid", [soonToExpire.invitation.id]);
    expect(await acceptCaptainInvitation(db, { invitationId: soonToExpire.invitation.id, userId: "acct-b" })).toEqual({ outcome: "expired" });
    expect(await redemptions()).toEqual([{ invitation_id: revokedInvite.invitation.id, user_id: "acct-a" }]);
  });

  it("commits the redemption row, the grant and the audit event together, or none of them", async () => {
    await seedAccount("acct-a");
    const { invitation } = await createInvitation();
    await rows("ALTER TABLE hq_audit_events ADD CONSTRAINT test_redeemed_failure CHECK (kind <> 'captain.invitation_redeemed')");
    try {
      await expect(acceptCaptainInvitation(db, { invitationId: invitation.id, userId: "acct-a" })).rejects.toThrow(/test_redeemed_failure/);
    } finally {
      await rows("ALTER TABLE hq_audit_events DROP CONSTRAINT test_redeemed_failure");
    }
    expect(await redemptions()).toEqual([]);
    expect(await grants()).toEqual([]);
    expect((await events()).map((e) => e.kind)).toEqual(["captain.invitation_created"]);
    // And a clean acceptance afterwards still works.
    expect(await acceptCaptainInvitation(db, { invitationId: invitation.id, userId: "acct-a" })).toEqual({ outcome: "granted" });
  });
});

describe("revokeCaptainInvitation", () => {
  it("stops future redemption, keeps existing grants, and is idempotent", async () => {
    const { invitation } = await createInvitation({ label: "Amsterdam" });
    const revoked = await revokeCaptainInvitation(db, { actorOperatorId: SECOND_OPERATOR, invitationId: invitation.id, reason: "Leaked in a public channel" });
    expect(revoked).toMatchObject({ id: invitation.id, state: "revoked", revokedByUserId: SECOND_OPERATOR });
    expect(revoked?.revokedAt).not.toBeNull();
    expect(await events()).toEqual([
      expect.objectContaining({ kind: "captain.invitation_created" }),
      { kind: "captain.invitation_revoked", actor_kind: "operator", actor_id: SECOND_OPERATOR, subject_user_id: null, metadata: { invitationId: invitation.id, reason: "Leaked in a public channel" } },
    ]);
    // Idempotent: revoking again writes nothing new.
    expect(await revokeCaptainInvitation(db, { actorOperatorId: OPERATOR, invitationId: invitation.id })).toBeNull();
    expect(await events()).toHaveLength(2);
  });

  it("returns null for an unknown invitation", async () => {
    expect(await revokeCaptainInvitation(db, { actorOperatorId: OPERATOR, invitationId: "00000000-0000-4000-8000-0000000000aa" })).toBeNull();
  });
});

describe("listCaptainInvitations", () => {
  it("lists label, capacity, used count, expiry, revocation state, creator and redeemers, newest first", async () => {
    await seedAccount("acct-a");
    await seedAccount("acct-b");
    const first = await createInvitation({ label: "First" });
    const second = await createInvitation({ label: "Second", maxRedemptions: 2 });
    await acceptCaptainInvitation(db, { invitationId: second.invitation.id, userId: "acct-a" });
    await acceptCaptainInvitation(db, { invitationId: second.invitation.id, userId: "acct-b" });
    await revokeCaptainInvitation(db, { actorOperatorId: OPERATOR, invitationId: first.invitation.id });

    const listing = await listCaptainInvitations(db);
    expect(listing.map((i) => i.label)).toEqual(["Second", "First"]); // newest created first
    const secondListed = listing.find((i) => i.label === "Second")!;
    expect(secondListed).toMatchObject({ maxRedemptions: 2, usedCount: 2, state: "full", createdByUserId: OPERATOR, createdByName: "Operator" });
    expect(secondListed.redeemers.map((r) => r.userId).sort()).toEqual(["acct-a", "acct-b"]);
    expect(secondListed.redeemers.every((r) => typeof r.redeemedAt === "string" && r.redeemedAt)).toBe(true);
    const firstListed = listing.find((i) => i.label === "First")!;
    expect(firstListed).toMatchObject({ state: "revoked", usedCount: 0, redeemers: [] });
  });

  it("shows an expired invitation as expired, not full or active", async () => {
    const { invitation } = await createInvitation({ label: "Old link" });
    await rows("UPDATE hq_captain_invitations SET expires_at = now() - interval '1 day' WHERE id = $1::uuid", [invitation.id]);
    const listed = (await listCaptainInvitations(db)).find((i) => i.id === invitation.id)!;
    expect(listed.state).toBe("expired");
  });

  it("still counts a redemption toward usedCount after its account is deleted, and shows it as deleted", async () => {
    await seedAccount("acct-a");
    const { invitation } = await createInvitation();
    await acceptCaptainInvitation(db, { invitationId: invitation.id, userId: "acct-a" });
    await rows("DELETE FROM hq_builder_profiles WHERE id = 'acct-a'");
    const listed = (await listCaptainInvitations(db)).find((i) => i.id === invitation.id)!;
    expect(listed).toMatchObject({ usedCount: 1, state: "full" });
    expect(listed.redeemers).toEqual([{ userId: null, name: null, redeemedAt: expect.any(String) }]);
  });

  it("has separate, non-overlapping effects from Captain revocation: stops future redemption only, touches neither an existing grant nor an existing assignment", async () => {
    await seedAccount("cap-sep");
    const { invitation } = await createInvitation();
    expect(await acceptCaptainInvitation(db, { invitationId: invitation.id, userId: "cap-sep" })).toEqual({ outcome: "granted" });
    const project = "00000000-0000-4000-8000-0000000000c1";
    await seedProject(project);
    expect((await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-sep" })).outcome).toBe("assigned");

    await revokeCaptainInvitation(db, { actorOperatorId: OPERATOR, invitationId: invitation.id });
    expect(await grants()).toEqual([{ user_id: "cap-sep", capability: "captain", active: true }]);
    expect(await currentAssignments()).toEqual([{ project_id: project, captain_user_id: "cap-sep" }]);
  });

  it("the reverse: Captain revocation (and its cascade) clears the assignment and touches no invitation", async () => {
    await seedAccount("cap-sep2");
    const { invitation } = await createInvitation();
    await acceptCaptainInvitation(db, { invitationId: invitation.id, userId: "cap-sep2" });
    const project = "00000000-0000-4000-8000-0000000000c2";
    await seedProject(project);
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-sep2" });
    const before = (await listCaptainInvitations(db)).find((i) => i.id === invitation.id)!;

    await revokeCapability(db, { actor: { kind: "operator", id: OPERATOR }, byOperatorId: OPERATOR, userId: "cap-sep2", capability: "captain", reason: "done" });
    await clearCaptainAssignments(db, { actor: { kind: "operator", id: OPERATOR }, byOperatorId: OPERATOR, captainUserId: "cap-sep2", reason: "done" });

    expect(await grants()).toEqual([{ user_id: "cap-sep2", capability: "captain", active: false }]);
    expect(await currentAssignments()).toEqual([]);
    const after = (await listCaptainInvitations(db)).find((i) => i.id === invitation.id)!;
    expect(after).toEqual(before);
  });
});

describe("assignCaptain", () => {
  it("refuses an account without an active captain grant, writing nothing", async () => {
    await seedAccount("plain-1");
    const project = "00000000-0000-4000-8000-000000000101";
    await seedProject(project);
    expect(await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "plain-1" })).toEqual({ outcome: "no_grant" });
    expect(await currentAssignments()).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it("treats a project from another edition exactly like a missing one", async () => {
    await seedCaptain("cap-edition");
    const project = "00000000-0000-4000-8000-000000000102";
    await seedProject(project, EDITION_A);
    const wrongEdition = await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_B, captainUserId: "cap-edition" });
    const missing = await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: "00000000-0000-4000-8000-0000000000ff", hackathonId: EDITION_B, captainUserId: "cap-edition" });
    expect(wrongEdition).toEqual({ outcome: "not_found" });
    expect(wrongEdition).toEqual(missing);
    expect(await currentAssignments()).toEqual([]);
  });

  it("assigns a first Captain, recorded in the same transaction as its audit event", async () => {
    await seedCaptain("cap-first");
    const project = "00000000-0000-4000-8000-000000000103";
    await seedProject(project);
    const result = await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-first", reason: "First assignment" });
    expect(result).toMatchObject({ outcome: "assigned", replacedCaptainUserId: null });
    expect(await currentAssignments()).toEqual([{ project_id: project, captain_user_id: "cap-first" }]);
    expect(await assignmentEvents()).toEqual([
      { kind: "captain.assigned", actor_kind: "operator", actor_id: OPERATOR, subject_user_id: "cap-first",
        metadata: { assignmentId: expect.any(String), reason: "First assignment", replacedCaptainUserId: null, acknowledgedUnresolvedMemberIds: [] } },
    ]);
  });

  it("reassignment ends the old assignment, starts the new one, and leaves exactly one current row plus history", async () => {
    await seedCaptain("cap-1a");
    await seedCaptain("cap-2a");
    const project = "00000000-0000-4000-8000-000000000104";
    await seedProject(project);
    const first = await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-1a" });
    if (first.outcome !== "assigned") throw new Error("setup failed");
    const second = await assignCaptain(db, { actorOperatorId: SECOND_OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-2a" });
    expect(second).toMatchObject({ outcome: "assigned", replacedCaptainUserId: "cap-1a" });
    if (second.outcome !== "assigned") throw new Error("setup failed");

    expect(await currentAssignments()).toEqual([{ project_id: project, captain_user_id: "cap-2a" }]);
    const history = await rows("SELECT captain_user_id, unassigned_at IS NOT NULL AS ended FROM hq_captain_assignments WHERE project_id = $1 ORDER BY assigned_at", [project]);
    expect(history).toEqual([{ captain_user_id: "cap-1a", ended: true }, { captain_user_id: "cap-2a", ended: false }]);
    expect((await assignmentEvents()).map((e) => [e.kind, e.subject_user_id])).toEqual([
      ["captain.assigned", "cap-1a"],
      ["captain.unassigned", "cap-1a"],
      ["captain.assigned", "cap-2a"],
    ]);

    // Reassigning to the same account already current is a no-op: no new
    // history row, no new audit event, the same assignment id comes back.
    const repeat = await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-2a" });
    expect(repeat).toEqual({ outcome: "assigned", assignmentId: second.assignmentId, replacedCaptainUserId: null });
    expect(await rows("SELECT count(*)::int AS n FROM hq_captain_assignments WHERE project_id = $1", [project])).toEqual([{ n: 2 }]);
    expect(await assignmentEvents()).toHaveLength(3);
  });

  it("a verified team member cannot be assigned to their own team — the owner case", async () => {
    await seedCaptain("owner-conflict");
    const project = "00000000-0000-4000-8000-000000000105";
    await seedImportedProject({ id: project, ownerUserId: "owner-conflict" });
    expect(await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "owner-conflict" }))
      .toEqual({ outcome: "conflict", conflict: { kind: "verified_member", role: "owner" } });
    expect(await currentAssignments()).toEqual([]);
  });

  it("a verified team member cannot be assigned to their own team — the joined-member case", async () => {
    await seedCaptain("member-conflict");
    const project = "00000000-0000-4000-8000-000000000106";
    await seedImportedProject({ id: project, ownerUserId: "owner-other-1" });
    await joinRoster(project, "member-conflict");
    expect(await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "member-conflict" }))
      .toEqual({ outcome: "conflict", conflict: { kind: "verified_member", role: "member" } });
    expect(await currentAssignments()).toEqual([]);
  });

  it("a roster identity linked to the candidate's account blocks assignment even without a verified HQ membership", async () => {
    await seedCaptain("linked-conflict");
    const project = "00000000-0000-4000-8000-000000000107";
    await seedImportedProject({ id: project, ownerUserId: "owner-other-2" });
    await rosterLinkedToAccount(project, "Roster Twin", "roster_twin", "linked-conflict");
    expect(await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "linked-conflict" }))
      .toEqual({ outcome: "conflict", conflict: { kind: "roster_member", memberName: "Roster Twin", memberUsername: "roster_twin" } });
    expect(await currentAssignments()).toEqual([]);
  });

  it("a project's own owner is a conflict even before verification — the window loadTeamMembership alone misses", async () => {
    await seedCaptain("pending-owner");
    const project = "00000000-0000-4000-8000-000000000108";
    await seedImportedProject({ id: project, ownerUserId: "pending-owner", verification: "pending" });
    // loadTeamMembership requires verification='verified' and would see nothing here on its own.
    expect(await loadTeamMembership(db, { userId: "pending-owner", projectId: project })).toBeNull();
    expect(await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "pending-owner" }))
      .toEqual({ outcome: "conflict", conflict: { kind: "claimant" } });
  });

  it("a claimant absent from the imported roster (or case-mismatched against it) is still a conflict, never needs_review", async () => {
    // importTeam only links a roster row to the claimant when a member's
    // username matches theirs exactly; here it does not, so owner_user_id is
    // set but no hq_project_members row names them at all. Without the
    // owner_user_id check, the roster scan below would see nothing tying
    // this candidate to the project and, with an unrelated unclaimed row
    // still on the roster, would answer needs_review instead of a hard
    // conflict — letting a single "Assign anyway" make a project's own
    // claimant its Captain.
    await seedCaptain("absent-owner");
    const project = "00000000-0000-4000-8000-000000000111";
    await seedImportedProject({ id: project, ownerUserId: "absent-owner", verification: "pending", linkOwnerToRoster: false });
    await unclaimedRosterRow(project, "Someone Else", "someone_else");
    expect(await rows("SELECT builder_user_id FROM hq_project_members WHERE project_id=$1 AND builder_user_id='absent-owner'", [project])).toEqual([]);
    expect(await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "absent-owner" }))
      .toEqual({ outcome: "conflict", conflict: { kind: "claimant" } });
    // Still a conflict once verified — now via loadTeamMembership itself
    // (verification='verified' plus owner_user_id is exactly its predicate,
    // no roster link required), so this new check's own job is specifically
    // the pending/rejected window loadTeamMembership cannot see.
    await rows("UPDATE hq_project_onboarding SET verification='verified' WHERE project_id=$1", [project]);
    expect(await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "absent-owner" }))
      .toEqual({ outcome: "conflict", conflict: { kind: "verified_member", role: "owner" } });
  });

  it("an unresolved roster identity produces the needs-review outcome rather than a silent pass, and only proceeds once explicitly acknowledged", async () => {
    await seedCaptain("cap-review");
    const project = "00000000-0000-4000-8000-000000000109";
    await seedImportedProject({ id: project, ownerUserId: "owner-other-3" });
    await unclaimedRosterRow(project, "Unclaimed One", "unclaimed_one");
    await rosterWithProvisionalPerson(project, "Provisional Two", "provisional_two");

    const first = await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-review" });
    expect(first.outcome).toBe("needs_review");
    if (first.outcome !== "needs_review") throw new Error("expected needs_review");
    expect(first.unresolved.map((m) => m.username).sort()).toEqual(["provisional_two", "unclaimed_one"]);
    // Nothing was written on the silent, unacknowledged pass.
    expect(await currentAssignments()).toEqual([]);
    expect(await assignmentEvents()).toEqual([]);

    const acknowledgedIds = first.unresolved.map((m) => m.memberId);
    const second = await assignCaptain(db, {
      actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-review",
      acknowledgedUnresolvedIds: acknowledgedIds,
    });
    expect(second.outcome).toBe("assigned");
    expect(await currentAssignments()).toEqual([{ project_id: project, captain_user_id: "cap-review" }]);
    // The exact rows overridden are on the trail, not just a count.
    const assignedEvent = (await assignmentEvents())[0];
    expect(assignedEvent).toMatchObject({ kind: "captain.assigned" });
    expect((assignedEvent.metadata as { acknowledgedUnresolvedMemberIds: string[] }).acknowledgedUnresolvedMemberIds.sort()).toEqual([...acknowledgedIds].sort());
  });

  it("refuses a stale acknowledgement: an id list that no longer matches the current unresolved set is treated as no acknowledgement at all", async () => {
    await seedCaptain("cap-stale");
    const project = "00000000-0000-4000-8000-000000000110";
    await seedImportedProject({ id: project, ownerUserId: "owner-other-stale" });
    await unclaimedRosterRow(project, "Unclaimed One", "unclaimed_one");
    await unclaimedRosterRow(project, "Unclaimed Two", "unclaimed_two");

    const first = await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-stale" });
    if (first.outcome !== "needs_review") throw new Error("expected needs_review");
    expect(first.unresolved).toHaveLength(2);

    // A completely wrong id list: refused, and the operator is handed the
    // real, current set again rather than an unhandled mismatch.
    const wrongIds = await assignCaptain(db, {
      actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-stale",
      acknowledgedUnresolvedIds: ["00000000-0000-4000-8000-0000000000ff"],
    });
    expect(wrongIds).toEqual({ outcome: "needs_review", unresolved: first.unresolved });

    // A subset of the real ids (one of the two rows resolved since the
    // operator last looked, in this test's telling: they just never saw
    // the second one) is also refused, not partially honoured.
    const partialIds = await assignCaptain(db, {
      actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-stale",
      acknowledgedUnresolvedIds: [first.unresolved[0].memberId],
    });
    expect(partialIds).toEqual({ outcome: "needs_review", unresolved: first.unresolved });
    expect(await currentAssignments()).toEqual([]);

    // The exact current set: goes through.
    const exact = await assignCaptain(db, {
      actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-stale",
      acknowledgedUnresolvedIds: first.unresolved.map((m) => m.memberId),
    });
    expect(exact.outcome).toBe("assigned");
  });

  it("refuses a duplicate-id substitution: the same real id sent twice never counts as acknowledging two distinct rows", async () => {
    await seedCaptain("cap-dup");
    const project = "00000000-0000-4000-8000-000000000111";
    await seedImportedProject({ id: project, ownerUserId: "owner-other-dup" });
    await unclaimedRosterRow(project, "Unclaimed One", "unclaimed_one_dup");
    await unclaimedRosterRow(project, "Unclaimed Two", "unclaimed_two_dup");

    const first = await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-dup" });
    if (first.outcome !== "needs_review") throw new Error("expected needs_review");
    expect(first.unresolved).toHaveLength(2);

    // Same array length as the real set, and every id sent is a real one —
    // a plain "same length, every id known" check would pass this — but
    // only one of the two rows was actually named twice, so the other was
    // never acknowledged at all.
    const duplicated = await assignCaptain(db, {
      actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-dup",
      acknowledgedUnresolvedIds: [first.unresolved[0].memberId, first.unresolved[0].memberId],
    });
    expect(duplicated).toEqual({ outcome: "needs_review", unresolved: first.unresolved });
    expect(await currentAssignments()).toEqual([]);
  });

  it("never compares display names: an unclaimed roster row whose name matches the candidate is still only 'needs review', never a silent conflict or a silent pass", async () => {
    await seedCaptain("Same Display Name");
    const project = "00000000-0000-4000-8000-000000001010";
    await seedImportedProject({ id: project, ownerUserId: "owner-other-4" });
    // The roster row's *name* matches the candidate's display name exactly,
    // but carries no person_id at all: a name match must never stand in for
    // an identity match, in either direction.
    await unclaimedRosterRow(project, "Same Display Name", "unrelated_handle");
    const result = await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "Same Display Name" });
    expect(result.outcome).toBe("needs_review");
  });

  it("a project with no imported roster (created directly in Admin) has nothing for source 2 to check, and a bare project assigns cleanly", async () => {
    await seedCaptain("cap-bare");
    const project = "00000000-0000-4000-8000-000000001011";
    await seedProject(project);
    expect((await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-bare" })).outcome).toBe("assigned");
  });

  it("two Promise.all-issued assignCaptain calls for the same never-before-assigned project settle to one current row — proves sequential safety only, the same thing the reassignment test already proves", async () => {
    await seedCaptain("cap-race-x");
    await seedCaptain("cap-race-y");
    const project = "00000000-0000-4000-8000-000000001012";
    await seedProject(project);
    // pgliteBuilderDatabase (tests/hq/helpers/db.ts) funnels every
    // transaction through one promise queue on PGlite's single connection:
    // each call's `db.transaction(...)` is invoked synchronously before
    // either awaits anything, so these two calls queue and run as two
    // strictly sequential, non-overlapping transactions in call order — not
    // an interleaved race. By the time the second call's own lock-order
    // step 4 runs, the first has already committed a real current row, so
    // this exercises the ordinary reassignment path (end the first, insert
    // the second), not the ON CONFLICT DO NOTHING path — the same thing
    // "reassignment ends the old assignment..." above already proves, just
    // reached through Promise.all instead of two sequential awaits. Kept
    // here anyway as a second, differently-shaped witness that nothing
    // about issuing the calls this way changes the outcome.
    const results = await Promise.all([
      assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-race-x" }),
      assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-race-y" }),
    ]);
    expect(results.map((r) => r.outcome)).toEqual(["assigned", "assigned"]);
    expect(await currentAssignments()).toEqual([{ project_id: project, captain_user_id: "cap-race-y" }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_captain_assignments WHERE project_id = $1", [project])).toEqual([{ n: 2 }]);
  });

  it("the ON CONFLICT DO NOTHING guard itself: a second current-row insert for the same project is silently refused at the database level, never a raised constraint violation", async () => {
    // What assignCaptain's own already_assigned branch (:626) relies on,
    // isolated from the rest of the function: within a single transaction,
    // lock order step 4's SELECT ... FOR UPDATE always sees (and ends)
    // any row this INSERT could conflict with — its WHERE clause
    // (`unassigned_at IS NULL`) is a strict superset of the partial unique
    // index's own predicate (`unassigned_at IS NULL AND captain_user_id IS
    // NOT NULL`), so assignCaptain can never reach this branch through its
    // own single transaction, only through two genuinely concurrent ones —
    // which this single-connection harness cannot produce (see the test
    // above). This proves the database mechanism itself holds, the same
    // way tests/hq/capabilities.test.ts's "allows one effective grant per
    // capability at the database level" proves its own partial index,
    // rather than trusting it as an assumption.
    await seedCaptain("cap-db-guard-1");
    await seedCaptain("cap-db-guard-2");
    const project = "00000000-0000-4000-8000-000000001025";
    await seedProject(project);
    const insertCurrent = (captainUserId: string) =>
      rows(
        `INSERT INTO hq_captain_assignments (project_id, captain_user_id, assigned_by_user_id)
         VALUES ($1::uuid, $2, $3::uuid)
         ON CONFLICT (project_id) WHERE unassigned_at IS NULL AND captain_user_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [project, captainUserId, OPERATOR],
      );
    expect(await insertCurrent("cap-db-guard-1")).toHaveLength(1);
    // The second insert conflicts with the first's still-live row and is
    // silently dropped — 0 rows back, no thrown error.
    await expect(insertCurrent("cap-db-guard-2")).resolves.toHaveLength(0);
    expect(await currentAssignments()).toEqual([{ project_id: project, captain_user_id: "cap-db-guard-1" }]);
  });

  it("locks the candidate's active grant, the project's onboarding row (if any) and the current assignment row for update — a regression guard, since PGlite's serialized test pool cannot itself prove concurrency safety", () => {
    const source = readFileSync(join(process.cwd(), "lib/hq/captains.ts"), "utf8");
    expect(source).toMatch(/FROM hq_account_capabilities WHERE user_id = \$1 AND capability = 'captain' AND revoked_at IS NULL FOR UPDATE/);
    expect(source).toMatch(/FROM hq_project_onboarding WHERE project_id = \$1::uuid FOR UPDATE/);
    expect(source).toMatch(/WHERE project_id = \$1::uuid AND unassigned_at IS NULL FOR UPDATE/);
    // The database-level backstop for the one case the lock order above
    // cannot itself serialize (see the header comment): a never-before-
    // assigned project has no hq_captain_assignments row yet for two
    // concurrent callers to lock against each other on.
    expect(source).toMatch(/ON CONFLICT \(project_id\) WHERE unassigned_at IS NULL AND captain_user_id IS NOT NULL DO NOTHING/);
  });
});

describe("the membership-acceptance lock order (lib/hq/builder-store.ts)", () => {
  it("redeemInvite and importTeam lock the same hq_project_onboarding row assignCaptain locks, and check hq_captain_assignments before admitting a member or a verified owner — a regression guard for the shared lock order", () => {
    const source = readFileSync(join(process.cwd(), "lib/hq/builder-store.ts"), "utf8");
    const redeemInvite = source.slice(source.indexOf("async redeemInvite"), source.indexOf("async dashboard"));
    expect(redeemInvite).toMatch(/FOR UPDATE OF i,o/);
    expect(redeemInvite).toMatch(/FROM hq_captain_assignments WHERE project_id=\$1 AND captain_user_id=\$2 AND unassigned_at IS NULL/);
    expect(redeemInvite.indexOf("FOR UPDATE OF i,o")).toBeLessThan(redeemInvite.indexOf("FROM hq_captain_assignments"));

    const importTeam = source.slice(source.indexOf("async importTeam"), source.indexOf("async requestReview"));
    expect(importTeam).toMatch(/FROM hq_project_onboarding WHERE hackathon_id=\$1 AND external_id=\$2 FOR UPDATE/);
    expect(importTeam).toMatch(/FROM hq_captain_assignments WHERE project_id=\$1 AND captain_user_id=\$2 AND unassigned_at IS NULL/);
    expect(importTeam.indexOf("FOR UPDATE`")).toBeLessThan(importTeam.indexOf("FROM hq_captain_assignments"));
  });
});

describe("unassignCaptain", () => {
  it("ends the current assignment, is idempotent, and audits the removal", async () => {
    await seedCaptain("cap-unassign");
    const project = "00000000-0000-4000-8000-000000001013";
    await seedProject(project);
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-unassign" });

    const result = await unassignCaptain(db, { actorOperatorId: SECOND_OPERATOR, projectId: project, hackathonId: EDITION_A, reason: "Stepping back" });
    expect(result).toMatchObject({ outcome: "unassigned", captainUserId: "cap-unassign" });
    expect(await currentAssignments()).toEqual([]);
    expect((await assignmentEvents()).map((e) => e.kind)).toEqual(["captain.assigned", "captain.unassigned"]);
    expect((await assignmentEvents())[1]).toMatchObject({ actor_id: SECOND_OPERATOR, subject_user_id: "cap-unassign", metadata: expect.objectContaining({ reason: "Stepping back" }) });

    // Idempotent: nothing live to end a second time.
    expect(await unassignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A })).toEqual({ outcome: "not_assigned" });
    expect(await assignmentEvents()).toHaveLength(2);
  });

  it("treats a project from another edition exactly like a missing one", async () => {
    await seedCaptain("cap-unassign-edition");
    const project = "00000000-0000-4000-8000-000000001014";
    await seedProject(project, EDITION_A);
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-unassign-edition" });
    expect(await unassignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_B })).toEqual({ outcome: "not_found" });
    // Unaffected: the assignment is still there for the correct edition.
    expect(await currentAssignments()).toEqual([{ project_id: project, captain_user_id: "cap-unassign-edition" }]);
  });

  it("a project with no assignment at all is not_assigned, not an error", async () => {
    const project = "00000000-0000-4000-8000-000000001015";
    await seedProject(project);
    expect(await unassignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A })).toEqual({ outcome: "not_assigned" });
  });
});

describe("clearCaptainAssignments and countAssignmentsForCaptain", () => {
  it("clears every current assignment across every edition, auditing each individually, and counting the same set beforehand", async () => {
    await seedCaptain("cap-multi");
    const p1 = "00000000-0000-4000-8000-000000001016";
    const p2 = "00000000-0000-4000-8000-000000001017";
    await seedProject(p1, EDITION_A, "Project One");
    await seedProject(p2, EDITION_B, "Project Two");
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: p1, hackathonId: EDITION_A, captainUserId: "cap-multi" });
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: p2, hackathonId: EDITION_B, captainUserId: "cap-multi" });

    const preflight = await countAssignmentsForCaptain(db, "cap-multi");
    expect(preflight.map((a) => a.projectId).sort()).toEqual([p1, p2].sort());
    expect(preflight.every((a) => a.projectName)).toBe(true);

    const cleared = await clearCaptainAssignments(db, { actor: { kind: "operator", id: OPERATOR }, byOperatorId: OPERATOR, captainUserId: "cap-multi", reason: "Revoked" });
    expect(cleared.map((c) => c.projectId).sort()).toEqual([p1, p2].sort());
    expect(await currentAssignments()).toEqual([]);
    expect(await countAssignmentsForCaptain(db, "cap-multi")).toEqual([]);
    const clearEvents = (await events()).filter((e) => e.kind === "captain.unassigned");
    expect(clearEvents).toHaveLength(2);
    expect(clearEvents.every((e) => e.subject_user_id === "cap-multi")).toBe(true);

    // Idempotent: nothing left to clear a second time.
    expect(await clearCaptainAssignments(db, { actor: { kind: "operator", id: OPERATOR }, byOperatorId: OPERATOR, captainUserId: "cap-multi" })).toEqual([]);
  });

  it("counts current assignments for many accounts in one indexed query, 0 for none", async () => {
    await seedCaptain("cap-batch-1");
    await seedCaptain("cap-batch-2");
    const p1 = "00000000-0000-4000-8000-000000001018";
    await seedProject(p1);
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: p1, hackathonId: EDITION_A, captainUserId: "cap-batch-1" });
    const queries: string[] = [];
    const counting = { query: (text: string, values?: unknown[]) => { queries.push(text); return db.query(text, values); } };
    const counts = await countAssignmentsForUsers(counting, ["cap-batch-1", "cap-batch-2", "cap-batch-1", "ghost"]);
    expect([...counts.entries()]).toEqual([["cap-batch-1", 1], ["cap-batch-2", 0], ["ghost", 0]]);
    expect(queries).toHaveLength(1);
  });

  it("revoking a grant and clearing its assignments are one transaction: forcing the clear's own audit write to fail leaves the grant active and the assignment live", async () => {
    // The exact composition lib/hq/actions/capabilities.ts#revokeCaptainCapability
    // uses: one builderDatabase().transaction() wrapping both revokeCapability
    // and clearCaptainAssignments, so a failure partway through rolls both back.
    await seedCaptain("cap-combined");
    const project = "00000000-0000-4000-8000-000000001024";
    await seedProject(project);
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-combined" });

    await rows("ALTER TABLE hq_audit_events ADD CONSTRAINT test_combined_failure CHECK (kind <> 'captain.unassigned')");
    try {
      await expect(db.transaction(async (tx) => {
        await revokeCapability(tx, { actor: { kind: "operator", id: OPERATOR }, byOperatorId: OPERATOR, userId: "cap-combined", capability: "captain", reason: "done" });
        await clearCaptainAssignments(tx, { actor: { kind: "operator", id: OPERATOR }, byOperatorId: OPERATOR, captainUserId: "cap-combined" });
      })).rejects.toThrow(/test_combined_failure/);
    } finally {
      await rows("ALTER TABLE hq_audit_events DROP CONSTRAINT test_combined_failure");
    }
    expect(await grants()).toEqual([{ user_id: "cap-combined", capability: "captain", active: true }]);
    expect(await currentAssignments()).toEqual([{ project_id: project, captain_user_id: "cap-combined" }]);
  });

  it("rolls the clear back if its own transaction fails, leaving the assignment live", async () => {
    await seedCaptain("cap-rollback");
    const project = "00000000-0000-4000-8000-000000001019";
    await seedProject(project);
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-rollback" });
    await rows("ALTER TABLE hq_audit_events ADD CONSTRAINT test_clear_failure CHECK (kind <> 'captain.unassigned')");
    try {
      await expect(clearCaptainAssignments(db, { actor: { kind: "operator", id: OPERATOR }, byOperatorId: OPERATOR, captainUserId: "cap-rollback" })).rejects.toThrow(/test_clear_failure/);
    } finally {
      await rows("ALTER TABLE hq_audit_events DROP CONSTRAINT test_clear_failure");
    }
    expect(await currentAssignments()).toEqual([{ project_id: project, captain_user_id: "cap-rollback" }]);
  });
});

describe("listAssignments", () => {
  it("lists every project's current Captain in one edition, and narrows to one Captain's own projects there", async () => {
    await seedCaptain("cap-list-1");
    await seedCaptain("cap-list-2");
    const p1 = "00000000-0000-4000-8000-000000001020";
    const p2 = "00000000-0000-4000-8000-000000001021";
    const p3 = "00000000-0000-4000-8000-000000001022";
    await seedProject(p1, EDITION_A, "Alpha");
    await seedProject(p2, EDITION_A, "Beta");
    await seedProject(p3, EDITION_B, "Gamma");
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: p1, hackathonId: EDITION_A, captainUserId: "cap-list-1" });
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: p2, hackathonId: EDITION_A, captainUserId: "cap-list-2" });
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: p3, hackathonId: EDITION_B, captainUserId: "cap-list-1" });

    const editionA = await listAssignments(db, { hackathonId: EDITION_A });
    expect(editionA.map((a) => [a.projectName, a.captainName])).toEqual([["Alpha", "cap-list-1"], ["Beta", "cap-list-2"]]);

    const justCap1 = await listAssignments(db, { hackathonId: EDITION_A, captainUserId: "cap-list-1" });
    expect(justCap1.map((a) => a.projectName)).toEqual(["Alpha"]);
    // Edition B's assignment for cap-list-1 is invisible from edition A's drilldown.
    expect(await listAssignments(db, { hackathonId: EDITION_B, captainUserId: "cap-list-1" })).toHaveLength(1);
  });

  it("never shows an orphaned row (a deleted account's former seat) as a current assignment", async () => {
    await seedCaptain("cap-orphan");
    const project = "00000000-0000-4000-8000-000000001023";
    await seedProject(project);
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-orphan" });
    await rows("DELETE FROM hq_builder_profiles WHERE id = 'cap-orphan'");
    expect(await listAssignments(db, { hackathonId: EDITION_A })).toEqual([]);
  });
});

describe("countAssignmentsByCaptain", () => {
  it("counts each Captain's current projects in one edition with one GROUP BY query, highest first — T4.5's leaderboard read, not a client-side grouping of listAssignments", async () => {
    await seedCaptain("cap-count-1");
    await seedCaptain("cap-count-2");
    const p1 = "00000000-0000-4000-8000-000000001026";
    const p2 = "00000000-0000-4000-8000-000000001027";
    const p3 = "00000000-0000-4000-8000-000000001028";
    const other = "00000000-0000-4000-8000-000000001029";
    await seedProject(p1, EDITION_A, "Alpha");
    await seedProject(p2, EDITION_A, "Beta");
    await seedProject(p3, EDITION_A, "Gamma");
    await seedProject(other, EDITION_B, "Delta");
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: p1, hackathonId: EDITION_A, captainUserId: "cap-count-1" });
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: p2, hackathonId: EDITION_A, captainUserId: "cap-count-1" });
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: p3, hackathonId: EDITION_A, captainUserId: "cap-count-2" });
    // A different edition's assignment for cap-count-1 must not inflate edition A's count.
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: other, hackathonId: EDITION_B, captainUserId: "cap-count-1" });

    const queries: string[] = [];
    const counting = { query: (text: string, values?: unknown[]) => { queries.push(text); return db.query(text, values); } };
    const counts = await countAssignmentsByCaptain(counting, EDITION_A);
    expect(counts).toEqual([
      { captainUserId: "cap-count-1", captainName: "cap-count-1", assignedCount: 2 },
      { captainUserId: "cap-count-2", captainName: "cap-count-2", assignedCount: 1 },
    ]);
    expect(queries).toHaveLength(1);
  });

  it("never counts an orphaned row (a deleted account's former seat)", async () => {
    await seedCaptain("cap-count-orphan");
    const project = "00000000-0000-4000-8000-000000001030";
    await seedProject(project);
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-count-orphan" });
    await rows("DELETE FROM hq_builder_profiles WHERE id = 'cap-count-orphan'");
    expect(await countAssignmentsByCaptain(db, EDITION_A)).toEqual([]);
  });

  it("excludes a project whose status does not count as active (plan section 3's 'active HQ projects')", async () => {
    await seedCaptain("cap-count-inactive");
    const [{ id: redStatusId }] = await rows("INSERT INTO hq_project_statuses(slug,label,color,counts_as_active,sort) VALUES('red-count','Red','red',false,2) RETURNING id::text AS id");
    const project = "00000000-0000-4000-8000-000000001038";
    await rows(
      `INSERT INTO hq_projects(id,hackathon_id,name,status_id,forecast_id,last_check_in)
       SELECT $1,$2,$3,$4,f.id,current_date FROM hq_project_forecasts f`,
      [project, EDITION_A, "Red Project", redStatusId],
    );
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-count-inactive" });
    expect(await countAssignmentsByCaptain(db, EDITION_A)).toEqual([]);
  });
});

describe("leaderboard", () => {
  it("carries only rank, display name, assigned count and the isYou marker — no id, project name or link", async () => {
    await seedCaptain("cap-lb-shape");
    const project = "00000000-0000-4000-8000-000000001031";
    await seedProject(project, EDITION_A, "Shape Project");
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-lb-shape" });

    const board = await leaderboard(db, EDITION_A);
    expect(board).toEqual([{ rank: 1, displayName: "cap-lb-shape", assignedCount: 1, isYou: false }]);
    expect(Object.keys(board[0]).sort()).toEqual(["assignedCount", "displayName", "isYou", "rank"]);
    expect(JSON.stringify(board)).not.toContain(project);
    expect(JSON.stringify(board)).not.toMatch(/https?:\/\//);
  });

  it("orders by assigned count descending, then display name ascending for ties, with a zero-assignment Captain falling to the bottom on its own — no second rule needed", async () => {
    await seedCaptain("Zed");
    await seedCaptain("Amy A");
    await seedCaptain("Amy B");
    const p1 = "00000000-0000-4000-8000-000000001032";
    const p2 = "00000000-0000-4000-8000-000000001033";
    await seedProject(p1, EDITION_A, "One");
    await seedProject(p2, EDITION_A, "Two");
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: p1, hackathonId: EDITION_A, captainUserId: "Amy A" });
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: p2, hackathonId: EDITION_A, captainUserId: "Amy B" });

    expect(await leaderboard(db, EDITION_A)).toEqual([
      { rank: 1, displayName: "Amy A", assignedCount: 1, isYou: false },
      { rank: 2, displayName: "Amy B", assignedCount: 1, isYou: false },
      { rank: 3, displayName: "Zed", assignedCount: 0, isYou: false },
    ]);
  });

  it("does not count an ended assignment or another edition's assignment", async () => {
    await seedCaptain("cap-lb-ended");
    const ended = "00000000-0000-4000-8000-000000001034";
    await seedProject(ended, EDITION_A, "Ended Project");
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: ended, hackathonId: EDITION_A, captainUserId: "cap-lb-ended" });
    await unassignCaptain(db, { actorOperatorId: OPERATOR, projectId: ended, hackathonId: EDITION_A });

    await seedCaptain("cap-lb-other-edition");
    const otherEdition = "00000000-0000-4000-8000-000000001035";
    await seedProject(otherEdition, EDITION_B, "Other Edition Project");
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: otherEdition, hackathonId: EDITION_B, captainUserId: "cap-lb-other-edition" });

    const board = await leaderboard(db, EDITION_A);
    expect(board.map((row) => row.displayName).sort()).toEqual(["cap-lb-ended", "cap-lb-other-edition"]);
    expect(board.every((row) => row.assignedCount === 0)).toBe(true);
  });

  it("drops a revoked Captain entirely, even one whose live assignment row a bare revokeCapability call (without clearCaptainAssignments) left standing", async () => {
    await seedCaptain("cap-lb-revoked");
    const project = "00000000-0000-4000-8000-000000001037";
    await seedProject(project, EDITION_A, "Still Live");
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-lb-revoked" });
    await revokeCapability(db, { actor: { kind: "operator", id: OPERATOR }, byOperatorId: OPERATOR, userId: "cap-lb-revoked", capability: "captain", reason: "test" });

    // The stray row really is still live — this proves the merge drops it, not that the state cannot occur.
    expect(await currentAssignments()).toEqual([{ project_id: project, captain_user_id: "cap-lb-revoked" }]);
    expect((await leaderboard(db, EDITION_A)).map((row) => row.displayName)).not.toContain("cap-lb-revoked");
  });

  it("includes an eligible Captain with no current assignment", async () => {
    await seedCaptain("cap-lb-zero");
    expect(await leaderboard(db, EDITION_A)).toEqual([{ rank: 1, displayName: "cap-lb-zero", assignedCount: 0, isYou: false }]);
  });

  it("marks only the viewer's own row, and marks none when there is no viewer", async () => {
    await seedCaptain("cap-lb-me");
    await seedCaptain("cap-lb-other");

    const mine = await leaderboard(db, EDITION_A, "cap-lb-me");
    expect(mine.find((row) => row.displayName === "cap-lb-me")?.isYou).toBe(true);
    expect(mine.find((row) => row.displayName === "cap-lb-other")?.isYou).toBe(false);

    expect((await leaderboard(db, EDITION_A)).every((row) => row.isYou === false)).toBe(true);
    expect((await leaderboard(db, EDITION_A, null)).every((row) => row.isYou === false)).toBe(true);
  });
});

describe("currentCaptainOfProject", () => {
  it("returns the current Captain's id and name, or null while none is assigned", async () => {
    await seedCaptain("cap-project-view");
    const project = "00000000-0000-4000-8000-000000001039";
    await seedProject(project, EDITION_A, "Viewed Project");
    expect(await currentCaptainOfProject(db, project)).toBeNull();

    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A, captainUserId: "cap-project-view" });
    expect(await currentCaptainOfProject(db, project)).toEqual({ captainUserId: "cap-project-view", captainName: "cap-project-view" });

    await unassignCaptain(db, { actorOperatorId: OPERATOR, projectId: project, hackathonId: EDITION_A });
    expect(await currentCaptainOfProject(db, project)).toBeNull();
  });
});

describe("the T4.5 reads are not exposed as a Server Action", () => {
  // "No route a Captain can hit to read another Captain's assignments: ...
  // no action that takes a captainUserId" — this task adds no Server Action
  // at all (reads only), and this keeps it that way: none of the new
  // functions may be re-exported from a "use server" module, which is what
  // would turn a server-side read into something a client could call
  // directly with an id of its choosing.
  it("finds no reference to leaderboard, listAssignments or currentCaptainOfProject in any Server Action module", () => {
    const actionsDir = join(process.cwd(), "lib/hq/actions");
    const files = readdirSync(actionsDir).filter((name) => name.endsWith(".ts") && readFileSync(join(actionsDir, name), "utf8").startsWith('"use server"'));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const source = readFileSync(join(actionsDir, name), "utf8");
      for (const symbol of ["leaderboard", "listAssignments", "currentCaptainOfProject"]) {
        expect(source, `${name} references ${symbol}`).not.toMatch(new RegExp(`\\b${symbol}\\b`));
      }
    }
  });
});
