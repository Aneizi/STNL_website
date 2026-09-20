// Step 1 of the Captain invitation flow: exchanging a token for a
// continuation (lib/hq/invite-exchange.ts). Against the real schema on
// PGlite — the acceptance check this covers is "link previews, failed
// signup and repeat acceptance do not spend slots," and this is the half of
// it that runs before anyone is even signed in.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { BuilderDatabase } from "@/lib/hq/builder-db";
import { createCaptainInvitation, revokeCaptainInvitation } from "@/lib/hq/captains";
import { exchangeCaptainInvitationToken } from "@/lib/hq/invite-exchange";
import { readInviteContinuation } from "@/lib/hq/invite-continuation";
import { createMigratedDatabase, pgliteBuilderDatabase } from "./helpers/db";

const OPERATOR = "00000000-0000-4000-8000-000000000001";
let pg: PGlite;
let db: BuilderDatabase;
const rows = async (text: string, values: unknown[] = []) => (await pg.query(text, values)).rows as Record<string, unknown>[];
const redemptions = () => rows("SELECT invitation_id::text AS invitation_id, user_id FROM hq_captain_invitation_redemptions");
const invitationCount = async () => Number((await rows("SELECT count(*)::int AS n FROM hq_captain_invitations"))[0].n);

async function createInvitation(overrides: Partial<{ maxRedemptions: number; expiresInDays: number }> = {}) {
  return createCaptainInvitation(db, { actorOperatorId: OPERATOR, maxRedemptions: 1, expiresInDays: 7, ...overrides });
}

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = pgliteBuilderDatabase(pg);
}, 30_000);

beforeEach(async () => {
  await pg.exec(
    "TRUNCATE hq_users, hq_captain_invitations, hq_captain_invitation_redemptions, hq_audit_events, hq_auth_verification, hq_login_limits RESTART IDENTITY CASCADE",
  );
  await rows("INSERT INTO hq_users(id,username,display_name,password_hash) VALUES($1,'operator','Operator','unused')", [OPERATOR]);
});

afterAll(async () => { await pg.close(); });

describe("exchangeCaptainInvitationToken", () => {
  it("consumes nothing for a valid token, called twice — a link preview, then a real visit", async () => {
    const { token, invitation } = await createInvitation();
    const first = await exchangeCaptainInvitationToken(db, { token, ip: "203.0.113.1" });
    const second = await exchangeCaptainInvitationToken(db, { token, ip: "203.0.113.1" });
    expect(first.continuationId).toBeTruthy();
    expect(second.continuationId).toBeTruthy();
    expect(second.continuationId).not.toEqual(first.continuationId); // each exchange gets its own continuation
    expect(await readInviteContinuation(db, first.continuationId!)).toEqual({ invitationId: invitation.id, expired: false, revoked: false, full: false });
    expect(await readInviteContinuation(db, second.continuationId!)).toEqual({ invitationId: invitation.id, expired: false, revoked: false, full: false });
    expect(await redemptions()).toEqual([]);
    expect(await invitationCount()).toBe(1);
  });

  it("never puts the token into the continuation id", async () => {
    const { token } = await createInvitation();
    const { continuationId } = await exchangeCaptainInvitationToken(db, { token, ip: "203.0.113.1" });
    expect(continuationId).not.toEqual(token);
    expect(continuationId).not.toContain(token);
  });

  it("creates no continuation for an unknown token, and writes nothing", async () => {
    const result = await exchangeCaptainInvitationToken(db, { token: "not-a-real-token", ip: "203.0.113.2" });
    expect(result.continuationId).toBeNull();
    expect(await redemptions()).toEqual([]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_auth_verification")).toEqual([{ n: 0 }]);
  });

  it("still records a continuation for a revoked token, carrying the revoked flag", async () => {
    const { token, invitation } = await createInvitation();
    await revokeCaptainInvitation(db, { actorOperatorId: OPERATOR, invitationId: invitation.id });
    const { continuationId } = await exchangeCaptainInvitationToken(db, { token, ip: "203.0.113.3" });
    expect(continuationId).toBeTruthy();
    expect(await readInviteContinuation(db, continuationId!)).toEqual({ invitationId: invitation.id, expired: false, revoked: true, full: false });
    expect(await redemptions()).toEqual([]);
  });

  it("still records a continuation for an expired token, carrying the expired flag", async () => {
    const { token, invitation } = await createInvitation();
    await rows("UPDATE hq_captain_invitations SET expires_at = now() - interval '1 minute' WHERE id = $1::uuid", [invitation.id]);
    const { continuationId } = await exchangeCaptainInvitationToken(db, { token, ip: "203.0.113.4" });
    expect(await readInviteContinuation(db, continuationId!)).toEqual({ invitationId: invitation.id, expired: true, revoked: false, full: false });
  });

  it("still records a continuation for an already-full token, carrying the full flag, without consuming a redemption", async () => {
    const { token, invitation } = await createInvitation({ maxRedemptions: 1 });
    await rows(`INSERT INTO hq_builder_profiles(id,email,name) VALUES('acct-a','acct-a@example.test','Acct A')`);
    await rows(`INSERT INTO hq_captain_invitation_redemptions(invitation_id,user_id) VALUES($1::uuid,'acct-a')`, [invitation.id]);
    const { continuationId } = await exchangeCaptainInvitationToken(db, { token, ip: "203.0.113.5" });
    expect(await readInviteContinuation(db, continuationId!)).toEqual({ invitationId: invitation.id, expired: false, revoked: false, full: true });
    expect(await redemptions()).toEqual([{ invitation_id: invitation.id, user_id: "acct-a" }]); // unchanged by the exchange itself
  });

  it("rate-limits an address after repeated exchanges, and a limited request creates no continuation either", async () => {
    const { token } = await createInvitation();
    let limited = 0;
    for (let i = 0; i < 35; i++) {
      const result = await exchangeCaptainInvitationToken(db, { token, ip: "198.51.100.9" });
      if (!result.continuationId) limited += 1;
    }
    expect(limited).toBe(5);
    // Blocked requests saturate the counter and create no continuation.
    expect(await rows("SELECT count FROM hq_login_limits WHERE key = 'invite-exchange:ip:198.51.100.9'")).toEqual([{ count: 31 }]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_auth_verification")).toEqual([{ n: 30 }]);
    // A different address is unaffected.
    expect((await exchangeCaptainInvitationToken(db, { token, ip: "198.51.100.10" })).continuationId).toBeTruthy();
  });
});
