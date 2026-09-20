// The member half of the Captain invitation flow: acceptCaptainInvitationFromContinuation
// (lib/hq/actions/invite.ts), the only write path a public visitor can reach.
// Driven the way a real submit reaches it — requireMemberActor()'s gate, a
// cookie holding a continuation id, and the real acceptCaptainInvitation
// transaction against PGlite — mirroring tests/hq/member-actions-authz.test.ts's
// pattern for a member-gated action.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const mocks = vi.hoisted(() => ({
  builderDatabase: vi.fn(),
  currentMember: vi.fn(),
  requireMember: vi.fn(),
  cookies: vi.fn(),
}));
vi.mock("@/lib/hq/builder-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hq/builder-db")>()),
  builderDatabase: mocks.builderDatabase,
}));
vi.mock("@/lib/hq/member-auth", () => ({ currentMember: mocks.currentMember, requireMember: mocks.requireMember }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies, headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); },
}));

import { acceptCaptainInvitationFromContinuation } from "@/lib/hq/actions/invite";
import type { BuilderDatabase } from "@/lib/hq/builder-db";
import { createCaptainInvitation } from "@/lib/hq/captains";
import { INVITE_CONTINUATION_COOKIE, newInviteContinuationId, recordInviteContinuation } from "@/lib/hq/invite-continuation";
import * as botConsent from "@/lib/hq/telegram-consent";
import { createMigratedDatabase, pgliteBuilderDatabase } from "./helpers/db";

const OPERATOR = "00000000-0000-4000-8000-000000000001";
let pg: PGlite;
let db: BuilderDatabase;
const rows = async (text: string, values: unknown[] = []) => (await pg.query(text, values)).rows as Record<string, unknown>[];
const grants = () => rows("SELECT user_id, capability, revoked_at IS NULL AS active FROM hq_account_capabilities");
const redemptions = () => rows("SELECT invitation_id::text AS invitation_id, user_id FROM hq_captain_invitation_redemptions");

/** Signs in as the given account; the real requireMemberActor() then reads its capabilities and Telegram identity for real, against PGlite. */
function signIn(id: string) {
  mocks.requireMember.mockResolvedValue({ id, email: null, name: id });
  mocks.currentMember.mockResolvedValue({ id, email: null, name: id });
}

function withContinuationCookie(value: string | undefined) {
  mocks.cookies.mockResolvedValue({ get: (name: string) => (name === INVITE_CONTINUATION_COOKIE && value !== undefined ? { value } : undefined) });
}

/** A verified account with the hq_builder_profiles row acceptCaptainInvitation requires. */
async function seedAccount(id: string) {
  await rows(`INSERT INTO hq_auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,true)`, [id, id, `${id}@example.test`]);
  await rows(`INSERT INTO hq_builder_profiles(id,email,name) VALUES($1,$2,$3)`, [id, `${id}@example.test`, id]);
}

async function connectTelegram(id: string) {
  await rows(`INSERT INTO hq_auth_account(id,issuer,"accountId","providerId","userId") VALUES($1,'https://oauth.telegram.org',$2,'telegram',$1)`, [id, `subject-${id}`]);
  await rows(`INSERT INTO hq_auth_telegram_identity(user_id,provider_subject,telegram_user_id) VALUES($1,$2,1234567)`, [id, `subject-${id}`]);
}

function reminderChoice(enabled: boolean) {
  const form = new FormData();
  form.set("botMessagingPreference", "included");
  if (enabled) form.set("botMessaging", "on");
  return form;
}

async function createInvitation(overrides: Partial<{ maxRedemptions: number; expiresInDays: number }> = {}) {
  return createCaptainInvitation(db, { actorOperatorId: OPERATOR, maxRedemptions: 1, expiresInDays: 7, ...overrides });
}

async function continuationFor(invitationId: string, overrides: Partial<{ expired: boolean; revoked: boolean; full: boolean }> = {}) {
  const id = newInviteContinuationId();
  await recordInviteContinuation(db, id, { invitationId, expired: false, revoked: false, full: false, ...overrides });
  return id;
}

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = pgliteBuilderDatabase(pg);
}, 30_000);

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.builderDatabase.mockReturnValue(db);
  await pg.exec(
    "TRUNCATE hq_users, hq_builder_profiles, hq_account_capabilities, hq_captain_invitations, hq_captain_invitation_redemptions, hq_audit_events, hq_auth_user, hq_auth_telegram_identity, hq_auth_verification RESTART IDENTITY CASCADE",
  );
  await rows("INSERT INTO hq_users(id,username,display_name,password_hash) VALUES($1,'operator','Operator','unused')", [OPERATOR]);
});

afterAll(async () => { await pg.close(); });

describe("acceptCaptainInvitationFromContinuation", () => {
  it("saves the checked reminder preference on acceptance and does not overwrite later changes on replay", async () => {
    await seedAccount("acct-bot");
    await connectTelegram("acct-bot");
    signIn("acct-bot");
    const { invitation } = await createInvitation();
    withContinuationCookie(await continuationFor(invitation.id));

    await expect(acceptCaptainInvitationFromContinuation(null, reminderChoice(true))).rejects.toThrow("REDIRECT:/hq/dashboard?welcome=captain");
    expect(await botConsent.getBotConsent("acct-bot")).toMatchObject({ messagingEnabled: true });
    expect(await rows("SELECT metadata FROM hq_audit_events WHERE kind = 'bot.consent_changed'")).toEqual([{ metadata: { enabled: true } }]);

    await botConsent.setBotConsent({ kind: "member", id: "acct-bot" }, false);
    await expect(acceptCaptainInvitationFromContinuation(null, reminderChoice(true))).rejects.toThrow("REDIRECT:/hq/dashboard");
    expect(await botConsent.getBotConsent("acct-bot")).toMatchObject({ messagingEnabled: false });
    expect(await redemptions()).toHaveLength(1);
  });

  it("honours an unchecked switch when reminders were previously enabled", async () => {
    await seedAccount("acct-bot");
    await connectTelegram("acct-bot");
    await botConsent.setBotConsent({ kind: "member", id: "acct-bot" }, true);
    signIn("acct-bot");
    const { invitation } = await createInvitation();
    withContinuationCookie(await continuationFor(invitation.id));
    await expect(acceptCaptainInvitationFromContinuation(null, reminderChoice(false))).rejects.toThrow("REDIRECT:/hq/dashboard?welcome=captain");
    expect(await botConsent.getBotConsent("acct-bot")).toMatchObject({ messagingEnabled: false });
  });

  it("leaves consent untouched when no reminder preference was submitted", async () => {
    await seedAccount("acct-bot");
    await connectTelegram("acct-bot");
    signIn("acct-bot");
    const { invitation } = await createInvitation();
    withContinuationCookie(await continuationFor(invitation.id));
    await expect(acceptCaptainInvitationFromContinuation(null, new FormData())).rejects.toThrow("REDIRECT:/hq/dashboard?welcome=captain");
    expect(await botConsent.getBotConsent("acct-bot")).toBeNull();
  });

  it("does not enable reminders when the invitation is refused", async () => {
    await seedAccount("acct-bot");
    await connectTelegram("acct-bot");
    signIn("acct-bot");
    const { invitation } = await createInvitation();
    withContinuationCookie(await continuationFor(invitation.id));
    await rows("UPDATE hq_captain_invitations SET revoked_at = now() WHERE id = $1::uuid", [invitation.id]);
    expect(await acceptCaptainInvitationFromContinuation(null, reminderChoice(true))).toEqual({ outcome: "revoked" });
    expect(await botConsent.getBotConsent("acct-bot")).toBeNull();
    expect(await redemptions()).toEqual([]);
  });

  it("preserves Captain access and returns a recovery message if Telegram was disconnected before submission", async () => {
    await seedAccount("acct-bot");
    signIn("acct-bot");
    const { invitation } = await createInvitation();
    withContinuationCookie(await continuationFor(invitation.id));
    expect(await acceptCaptainInvitationFromContinuation(null, reminderChoice(true))).toEqual({ outcome: "granted", botError: "not-connected" });
    expect(await grants()).toEqual([{ user_id: "acct-bot", capability: "captain", active: true }]);
    expect(await botConsent.getBotConsent("acct-bot")).toBeNull();
  });

  it("offers Account recovery if saving reminders fails after Captain access was granted", async () => {
    await seedAccount("acct-bot");
    await connectTelegram("acct-bot");
    signIn("acct-bot");
    const { invitation } = await createInvitation();
    withContinuationCookie(await continuationFor(invitation.id));
    vi.spyOn(botConsent, "setBotConsent").mockRejectedValueOnce(new Error("database unavailable"));
    expect(await acceptCaptainInvitationFromContinuation(null, reminderChoice(true))).toEqual({ outcome: "granted", botError: "save-failed" });
    expect(await grants()).toEqual([{ user_id: "acct-bot", capability: "captain", active: true }]);
    expect(await redemptions()).toHaveLength(1);
  });

  it("refuses a signed-out visitor: requireMemberActor's own gate, before any continuation is even read", async () => {
    mocks.requireMember.mockImplementation(async (next?: string) => { throw new Error(`REDIRECT:/hq/login?next=${encodeURIComponent(next ?? "")}`); });
    withContinuationCookie(undefined);
    await expect(acceptCaptainInvitationFromContinuation(null, new FormData())).rejects.toThrow("REDIRECT:/hq/login?next=%2Fhq%2Finvite%2Fcontinue");
    expect(await redemptions()).toEqual([]);
  });

  it("a failed sign-up followed by a successful one consumes exactly one slot — the acceptance check the plan names directly", async () => {
    const { invitation } = await createInvitation({ maxRedemptions: 3 });
    const cookieValue = await continuationFor(invitation.id);
    withContinuationCookie(cookieValue);

    // A visitor who has not finished signing up yet — no member session —
    // retries the accept control a few times. requireMemberActor()'s own
    // gate refuses every one of them before the continuation is even read.
    mocks.requireMember.mockImplementation(async (next?: string) => { throw new Error(`REDIRECT:/hq/login?next=${encodeURIComponent(next ?? "")}`); });
    for (let i = 0; i < 3; i++) {
      await expect(acceptCaptainInvitationFromContinuation(null, new FormData())).rejects.toThrow(/^REDIRECT:/);
    }
    expect(await redemptions()).toEqual([]);

    // Sign-up succeeds; the same continuation cookie is still there.
    await seedAccount("acct-signed-up");
    signIn("acct-signed-up");
    await expect(acceptCaptainInvitationFromContinuation(null, new FormData())).rejects.toThrow("REDIRECT:/hq/dashboard?welcome=captain");
    expect(await redemptions()).toEqual([{ invitation_id: invitation.id, user_id: "acct-signed-up" }]);

    // Submitting again afterwards — a page refresh, a second click — still consumes nothing further.
    await expect(acceptCaptainInvitationFromContinuation(null, new FormData())).rejects.toThrow("REDIRECT:/hq/dashboard");
    expect(await redemptions()).toEqual([{ invitation_id: invitation.id, user_id: "acct-signed-up" }]);
  });

  it("refuses an unverified account, without touching the database", async () => {
    // The session gate passed (requireMember is mocked), but the account
    // itself is not verified in hq_auth_user — acceptCaptainInvitation's own
    // independent check (lib/hq/captains.ts#isVerifiedForRedemption) is what
    // actually refuses this, exactly the defence-in-depth it is documented
    // to be, exercised here through the real action rather than the bare
    // service call tests/hq/captains.test.ts already covers.
    await rows(`INSERT INTO hq_auth_user(id,name,email,"emailVerified") VALUES('acct-unverified','Acct','acct-unverified@telegram.placeholder.invalid',false)`);
    await rows(`INSERT INTO hq_builder_profiles(id,email,name) VALUES('acct-unverified',NULL,'Acct')`);
    signIn("acct-unverified");
    const { invitation } = await createInvitation();
    withContinuationCookie(await continuationFor(invitation.id));
    expect(await acceptCaptainInvitationFromContinuation(null, new FormData())).toEqual({ outcome: "unverified" });
    expect(await grants()).toEqual([]);
    expect(await redemptions()).toEqual([]);
  });

  it("grants Captain to a verified, signed-in account, then leaves a second acceptance a no-op that consumes no slot", async () => {
    await seedAccount("acct-a");
    signIn("acct-a");
    const { invitation } = await createInvitation({ maxRedemptions: 5 });
    withContinuationCookie(await continuationFor(invitation.id));

    await expect(acceptCaptainInvitationFromContinuation(null, new FormData())).rejects.toThrow("REDIRECT:/hq/dashboard?welcome=captain");
    expect(await grants()).toEqual([{ user_id: "acct-a", capability: "captain", active: true }]);
    expect(await redemptions()).toEqual([{ invitation_id: invitation.id, user_id: "acct-a" }]);

    // A second submission — a double click, a retried request — reaches the
    // same continuation again and consumes nothing further.
    await expect(acceptCaptainInvitationFromContinuation(null, new FormData())).rejects.toThrow("REDIRECT:/hq/dashboard");
    expect(await redemptions()).toEqual([{ invitation_id: invitation.id, user_id: "acct-a" }]);
  });

  it("keeps unsuccessful invitation outcomes on the invitation page", async () => {
    await seedAccount("acct-full");
    await seedAccount("acct-other");
    signIn("acct-full");
    const { invitation } = await createInvitation({ maxRedemptions: 1 });
    await rows(`INSERT INTO hq_captain_invitation_redemptions(invitation_id,user_id) VALUES($1::uuid,'acct-other')`, [invitation.id]);
    withContinuationCookie(await continuationFor(invitation.id));
    expect(await acceptCaptainInvitationFromContinuation(null, new FormData())).toEqual({ outcome: "full" });
  });

  it("is refused for a missing, forged or expired continuation — identically, without reaching acceptCaptainInvitation at all", async () => {
    await seedAccount("acct-a");
    signIn("acct-a");

    withContinuationCookie(undefined);
    expect(await acceptCaptainInvitationFromContinuation(null, new FormData())).toEqual({ outcome: "invalid-continuation" });

    withContinuationCookie("forged-id-nobody-issued");
    expect(await acceptCaptainInvitationFromContinuation(null, new FormData())).toEqual({ outcome: "invalid-continuation" });

    const { invitation } = await createInvitation();
    const expiredId = await continuationFor(invitation.id);
    await rows(`UPDATE hq_auth_verification SET "expiresAt" = now() - interval '1 second' WHERE identifier = $1`, [`hq-invite-continuation:${expiredId}`]);
    withContinuationCookie(expiredId);
    expect(await acceptCaptainInvitationFromContinuation(null, new FormData())).toEqual({ outcome: "invalid-continuation" });

    expect(await grants()).toEqual([]);
    expect(await redemptions()).toEqual([]);
  });

  it("still checks the account's own verification and profile even when the continuation names a real, open invitation", async () => {
    // Verified in hq_auth_user, no hq_builder_profiles row yet.
    await rows(`INSERT INTO hq_auth_user(id,name,email,"emailVerified") VALUES('acct-new','New','acct-new@example.test',true)`);
    signIn("acct-new");
    const { invitation } = await createInvitation();
    withContinuationCookie(await continuationFor(invitation.id));
    expect(await acceptCaptainInvitationFromContinuation(null, new FormData())).toEqual({ outcome: "no-profile" });
    expect(await redemptions()).toEqual([]);
  });
});
