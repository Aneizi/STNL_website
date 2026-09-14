// The Captain invitation service against the real schema on PGlite: only the
// hash is ever stored, capacity is enforced under a real row lock, the
// idempotence and "no resurrection on replay" rules hold, revocation stops
// only future redemption, and a redemption's capability grant and audit
// event commit or roll back together with its redemption row.
import { readFileSync } from "node:fs";
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
  acceptCaptainInvitation, createCaptainInvitation, listCaptainInvitations,
  readCaptainInvitationByToken, revokeCaptainInvitation,
} from "@/lib/hq/captains";
import type { BuilderDatabase } from "@/lib/hq/builder-db";
import { createMigratedDatabase, pgliteBuilderDatabase } from "./helpers/db";

const OPERATOR = "00000000-0000-4000-8000-000000000001";
const SECOND_OPERATOR = "00000000-0000-4000-8000-000000000002";
let pg: PGlite;
let db: BuilderDatabase;
let telegramCounter = 1_000_000;

async function rows(text: string, values: unknown[] = []) { return (await pg.query(text, values)).rows as Record<string, unknown>[]; }

/** A verified-by-email, verified-by-Telegram, or deliberately unverified HQ account, plus its hq_builder_profiles row (every service call needs one). */
async function seedAccount(id: string, verified: "email" | "telegram" | "none" = "email") {
  const email = verified === "email" ? `${id}@example.test` : `${id}@telegram.placeholder.invalid`;
  await rows(`INSERT INTO hq_auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,$4)`, [id, id, email, verified === "email"]);
  await rows(`INSERT INTO hq_builder_profiles(id,email,name) VALUES($1,$2,$3)`, [id, verified === "email" ? email : null, id]);
  if (verified === "telegram") {
    telegramCounter += 1;
    await rows(`INSERT INTO hq_auth_telegram_identity(user_id,provider_subject,telegram_user_id,username) VALUES($1,$2,$3,$4)`, [id, `subject-${id}`, telegramCounter, id]);
  }
}

async function createInvitation(overrides: Partial<{ actorOperatorId: string; label: string | null; maxRedemptions: number; expiresInDays: number }> = {}) {
  return createCaptainInvitation(db, { actorOperatorId: OPERATOR, maxRedemptions: 1, expiresInDays: 7, ...overrides });
}

const grants = () => rows("SELECT user_id,capability,revoked_at IS NULL AS active FROM hq_account_capabilities ORDER BY granted_at,id");
const redemptions = () => rows("SELECT invitation_id::text AS invitation_id,user_id FROM hq_captain_invitation_redemptions ORDER BY redeemed_at,id");
const events = () => rows("SELECT kind,actor_kind,actor_id,subject_user_id,metadata FROM hq_audit_events ORDER BY id");

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = pgliteBuilderDatabase(pg);
  mocks.builderDatabase.mockReturnValue(db);
}, 30_000);

beforeEach(async () => {
  await pg.exec(
    "TRUNCATE hq_users, hq_builder_profiles, hq_audit_events, hq_auth_user, hq_auth_telegram_identity, hq_account_capabilities, hq_captain_invitations, hq_captain_invitation_redemptions RESTART IDENTITY CASCADE",
  );
  await rows("INSERT INTO hq_users(id,username,display_name,password_hash) VALUES($1,'operator','Operator','unused'),($2,'second','Second','unused')", [OPERATOR, SECOND_OPERATOR]);
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
});
