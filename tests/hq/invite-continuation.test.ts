// The Captain invitation continuation store: a short-lived, tokenless
// pointer at an invitation, keyed by a random id instead of a user id
// (lib/hq/invite-continuation.ts). Against the real hq_auth_verification
// table on PGlite — the same table lib/hq/telegram-identity-plugin.ts's
// recordTelegramIntent uses, reused directly here rather than through
// Better Auth's internalAdapter.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { BuilderDatabase } from "@/lib/hq/builder-db";
import {
  INVITE_CONTINUATION_TTL_MS,
  inviteContinuationCookieOptions,
  newInviteContinuationId,
  readInviteContinuation,
  recordInviteContinuation,
} from "@/lib/hq/invite-continuation";
import { createMigratedDatabase, pgliteBuilderDatabase } from "./helpers/db";

let pg: PGlite;
let db: BuilderDatabase;
const rows = async (text: string, values: unknown[] = []) => (await pg.query(text, values)).rows as Record<string, unknown>[];

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = pgliteBuilderDatabase(pg);
}, 30_000);

beforeEach(async () => {
  await pg.exec("TRUNCATE hq_auth_verification RESTART IDENTITY CASCADE");
});

afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => { await pg.close(); });

describe("newInviteContinuationId", () => {
  it("is a random, URL-safe id unrelated to any invitation id", () => {
    const a = newInviteContinuationId();
    const b = newInviteContinuationId();
    expect(a).not.toEqual(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(24);
  });
});

describe("recordInviteContinuation / readInviteContinuation", () => {
  it("round-trips exactly what was stored", async () => {
    const id = newInviteContinuationId();
    await recordInviteContinuation(db, id, { invitationId: "inv-1", expired: false, revoked: false, full: false });
    expect(await readInviteContinuation(db, id)).toEqual({ invitationId: "inv-1", expired: false, revoked: false, full: false });
  });

  it("is null for an id that was never recorded — a forged or guessed cookie value", async () => {
    expect(await readInviteContinuation(db, "never-recorded")).toBeNull();
    expect(await readInviteContinuation(db, "")).toBeNull();
  });

  it("is null once the row has expired, and stays null on every later read", async () => {
    const id = newInviteContinuationId();
    await recordInviteContinuation(db, id, { invitationId: "inv-1", expired: false, revoked: false, full: false });
    await rows(`UPDATE hq_auth_verification SET "expiresAt" = now() - interval '1 second' WHERE identifier = $1`, [`hq-invite-continuation:${id}`]);
    expect(await readInviteContinuation(db, id)).toBeNull();
    expect(await readInviteContinuation(db, id)).toBeNull();
  });

  it("is read repeatedly without being consumed — unlike recordTelegramIntent, a page load or a retried accept must not burn it", async () => {
    const id = newInviteContinuationId();
    await recordInviteContinuation(db, id, { invitationId: "inv-1", expired: false, revoked: false, full: false });
    for (let i = 0; i < 3; i++) {
      expect(await readInviteContinuation(db, id)).toEqual({ invitationId: "inv-1", expired: false, revoked: false, full: false });
    }
  });

  it("stores the invitation's exchange-time flags, not just its id", async () => {
    const id = newInviteContinuationId();
    await recordInviteContinuation(db, id, { invitationId: "inv-2", expired: true, revoked: false, full: false });
    expect(await readInviteContinuation(db, id)).toEqual({ invitationId: "inv-2", expired: true, revoked: false, full: false });
  });

  it("carries no other invitation field: only invitationId and the three flags reach the row", async () => {
    const id = newInviteContinuationId();
    await recordInviteContinuation(db, id, { invitationId: "inv-3", expired: false, revoked: false, full: false });
    const [row] = await rows(`SELECT value FROM hq_auth_verification WHERE identifier = $1`, [`hq-invite-continuation:${id}`]);
    expect(Object.keys(JSON.parse(String(row.value))).sort()).toEqual(["expired", "full", "invitationId", "revoked"]);
  });

  it("opportunistically clears its own expired rows on the next write, without touching an unrelated verification row", async () => {
    const stale = newInviteContinuationId();
    await recordInviteContinuation(db, stale, { invitationId: "inv-old", expired: false, revoked: false, full: false });
    await rows(`UPDATE hq_auth_verification SET "expiresAt" = now() - interval '1 day' WHERE identifier = $1`, [`hq-invite-continuation:${stale}`]);
    await rows(`INSERT INTO hq_auth_verification (id, identifier, value, "expiresAt") VALUES ('other-row', 'hq-telegram-intent:acct-1', 'link', now() - interval '1 day')`);

    const fresh = newInviteContinuationId();
    await recordInviteContinuation(db, fresh, { invitationId: "inv-new", expired: false, revoked: false, full: false });

    expect(await rows(`SELECT identifier FROM hq_auth_verification WHERE identifier = $1`, [`hq-invite-continuation:${stale}`])).toEqual([]);
    // A different module's expired row is left for its own owner to clean up.
    expect(await rows(`SELECT identifier FROM hq_auth_verification WHERE identifier = 'hq-telegram-intent:acct-1'`)).toHaveLength(1);
  });
});

describe("inviteContinuationCookieOptions", () => {
  it("is httpOnly, scoped to /hq/invite, and expires with the continuation's own TTL", () => {
    const options = inviteContinuationCookieOptions();
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/hq/invite" });
    expect(options.maxAge).toBe(INVITE_CONTINUATION_TTL_MS / 1000);
  });

  it("follows the member session's own secure-cookie policy: secure over a configured https origin, not over an unconfigured one", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://hq.example.com");
    expect(inviteContinuationCookieOptions().secure).toBe(true);
    vi.stubEnv("BETTER_AUTH_URL", "");
    expect(inviteContinuationCookieOptions().secure).toBe(false);
  });
});
