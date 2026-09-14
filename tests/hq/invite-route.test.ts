// The exchange step (app/hq/(member)/invite/[token]/route.ts): a GET that
// must never consume the invitation, must never echo the token back, and
// must set an httpOnly, tokenless continuation cookie. Driven through the
// real exported GET handler with a real NextRequest, against PGlite.
import type { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ builderDatabase: vi.fn(), currentMember: vi.fn(), ip: "203.0.113.50" }));
vi.mock("@/lib/hq/builder-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hq/builder-db")>()),
  builderDatabase: mocks.builderDatabase,
}));
vi.mock("@/lib/hq/member-auth", () => ({ currentMember: mocks.currentMember }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": mocks.ip }) }));

import { GET } from "@/app/hq/(member)/invite/[token]/route";
import type { BuilderDatabase } from "@/lib/hq/builder-db";
import { createCaptainInvitation, revokeCaptainInvitation } from "@/lib/hq/captains";
import { INVITE_CONTINUATION_COOKIE, readInviteContinuation } from "@/lib/hq/invite-continuation";
import { createMigratedDatabase, pgliteBuilderDatabase } from "./helpers/db";

const OPERATOR = "00000000-0000-4000-8000-000000000001";
const ORIGIN = "https://hq.invalid";
let pg: PGlite;
let db: BuilderDatabase;
const rows = async (text: string, values: unknown[] = []) => (await pg.query(text, values)).rows as Record<string, unknown>[];
const redemptions = () => rows("SELECT invitation_id::text AS invitation_id, user_id FROM hq_captain_invitation_redemptions");

async function createInvitation(overrides: Partial<{ maxRedemptions: number; expiresInDays: number }> = {}) {
  return createCaptainInvitation(db, { actorOperatorId: OPERATOR, maxRedemptions: 1, expiresInDays: 7, ...overrides });
}

function exchange(token: string) {
  const request = new NextRequest(`${ORIGIN}/hq/invite/${encodeURIComponent(token)}`);
  return GET(request, { params: Promise.resolve({ token }) });
}

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = pgliteBuilderDatabase(pg);
}, 30_000);

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.builderDatabase.mockReturnValue(db);
  mocks.currentMember.mockResolvedValue(null);
  mocks.ip = "203.0.113.50";
  await pg.exec(
    "TRUNCATE hq_users, hq_captain_invitations, hq_captain_invitation_redemptions, hq_audit_events, hq_auth_verification, hq_login_limits RESTART IDENTITY CASCADE",
  );
  await rows("INSERT INTO hq_users(id,username,display_name,password_hash) VALUES($1,'operator','Operator','unused')", [OPERATOR]);
});

afterAll(async () => { await pg.close(); });

describe("GET /hq/invite/[token]", () => {
  it("checks the session (every /hq surface does, tests/hq/auth-boundary.test.ts) without ever gating on it", async () => {
    const { token } = await createInvitation();
    await exchange(token);
    expect(mocks.currentMember).toHaveBeenCalledTimes(1);
  });

  it("redirects to the tokenless continuation page, with no token anywhere in the target", async () => {
    const { token } = await createInvitation();
    const response = await exchange(token);
    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toBe(`${ORIGIN}/hq/invite/continue`);
    expect(location).not.toContain(token);
  });

  it("sets an httpOnly continuation cookie scoped to /hq/invite, and the stored continuation names the right invitation", async () => {
    const { token, invitation } = await createInvitation();
    const response = await exchange(token);
    const cookie = response.cookies.get(INVITE_CONTINUATION_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.path).toBe("/hq/invite");
    expect(cookie!.value).not.toEqual(token);
    expect(await readInviteContinuation(db, cookie!.value)).toEqual({ invitationId: invitation.id, expired: false, revoked: false, full: false });
  });

  it("consumes nothing, exchanged twice for the same token — a link preview, then a real visit", async () => {
    const { token } = await createInvitation();
    await exchange(token);
    await exchange(token);
    expect(await redemptions()).toEqual([]);
    expect(await rows("SELECT count(*)::int AS n FROM hq_captain_invitations")).toEqual([{ n: 1 }]);
  });

  it("redirects an unknown token the same way, but sets no continuation cookie", async () => {
    const response = await exchange("no-such-token");
    expect(response.headers.get("location")).toBe(`${ORIGIN}/hq/invite/continue`);
    expect(response.cookies.get(INVITE_CONTINUATION_COOKIE)).toBeUndefined();
  });

  it("still redirects to the continuation page for a revoked token, with a continuation that says so", async () => {
    const { token, invitation } = await createInvitation();
    await revokeCaptainInvitation(db, { actorOperatorId: OPERATOR, invitationId: invitation.id });
    const response = await exchange(token);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/hq/invite/continue`);
    const cookie = response.cookies.get(INVITE_CONTINUATION_COOKIE)!;
    expect(await readInviteContinuation(db, cookie.value)).toMatchObject({ revoked: true });
  });
});
