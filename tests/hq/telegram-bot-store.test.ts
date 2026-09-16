// The bot's durable state, on its own: the guards on a callback reference,
// the chat binding, and the retention sweep.
//
// These are the parts the flow relies on but cannot demonstrate by itself,
// because each is about what happens between two updates rather than inside
// one: a button minted for another chat, a draft left overnight, a receipt
// old enough to forget.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ builderDatabase: vi.fn() }));
vi.mock("@/lib/hq/builder-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hq/builder-db")>()),
  builderDatabase: mocks.builderDatabase,
}));

import type { BuilderDatabase } from "@/lib/hq/builder-db";
import {
  bindBotChat,
  botMessagingEnabled,
  claimBotDraft,
  claimTelegramUpdate,
  clearBotDraft,
  consumeBotAction,
  createBotAction,
  deliverableBotChat,
  DRAFT_TTL_MS,
  enqueueBotMessage,
  finishTelegramUpdate,
  isDraftAction,
  isWriteAction,
  MAX_UPDATE_ATTEMPTS,
  purgeExpiredBotState,
  readBotAction,
  readBotDraft,
  startBotDraft,
  advanceBotDraft,
  UPDATE_LEASE_MS,
} from "@/lib/hq/telegram-bot-store";
import { createMigratedDatabase, pgliteBuilderDatabase } from "./helpers/db";

const USER = "acct-bot";
const OTHER = "acct-other";
const CHAT = "7000000000555";
const OTHER_CHAT = "7000000000666";
const PROJECT = "00000000-0000-4000-9300-000000000001";

let pg: PGlite;
let db: BuilderDatabase;

async function rows(text: string, values: unknown[] = []) {
  return (await pg.query(text, values)).rows as Record<string, unknown>[];
}

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = pgliteBuilderDatabase(pg);
  mocks.builderDatabase.mockReturnValue(db);
}, 40_000);

afterAll(async () => { await pg.close(); });

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM hq_telegram_outgoing; DELETE FROM hq_telegram_drafts; DELETE FROM hq_telegram_actions;
    DELETE FROM hq_telegram_updates; DELETE FROM hq_telegram_bot_consent;
    DELETE FROM hq_auth_telegram_identity; DELETE FROM hq_auth_user; DELETE FROM hq_builder_profiles;
  `);
  await rows("INSERT INTO hq_builder_profiles(id,email,name) VALUES($1,$2,'Bot account'),($3,$4,'Other account')", [USER, `${USER}@example.test`, OTHER, `${OTHER}@example.test`]);
  // The verified Telegram identity behind the account. A chat is only a
  // destination when the identity connected NOW is the one that opened it, so
  // a fixture that binds a chat without an identity is not a deliverable
  // account, which is what these tests are about.
  await rows(`INSERT INTO hq_auth_user(id,name,email,"emailVerified") VALUES($1,'Bot account',$2,true)`, [USER, `${USER}@example.test`]);
  await rows("INSERT INTO hq_auth_telegram_identity(user_id,provider_subject,telegram_user_id) VALUES($1,$2,$3::bigint)", [USER, `telegram:${CHAT}`, CHAT]);
  await rows(`INSERT INTO hq_auth_account(id,issuer,"accountId","providerId","userId") VALUES('telegram-test','https://oauth.telegram.org',$1,'telegram',$2)`, [`telegram:${CHAT}`, USER]);
});

describe("update receipts", () => {
  it("does not let an expired attempt finish over its replacement", async () => {
    const start = Date.now();
    await claimTelegramUpdate(db, 5010, start);
    await claimTelegramUpdate(db, 5010, start + UPDATE_LEASE_MS + 1);
    await finishTelegramUpdate(db, 5010, "failed", "old_attempt", 1);
    expect((await rows("SELECT state, attempts FROM hq_telegram_updates WHERE update_id=5010"))[0]).toMatchObject({ state: "processing", attempts: 2 });
    await finishTelegramUpdate(db, 5010, "done", undefined, 2);
    await finishTelegramUpdate(db, 5010, "failed", "late_failure", 1);
    expect((await rows("SELECT state FROM hq_telegram_updates WHERE update_id=5010"))[0].state).toBe("done");
  });
  it("leases an update, refuses an overlapping delivery, and never re-runs a finished one", async () => {
    expect(await claimTelegramUpdate(db, 5001)).toMatchObject({ accepted: true, attempts: 1 });
    // A second delivery while the first invocation still holds the lease.
    expect(await claimTelegramUpdate(db, 5001)).toEqual({ accepted: false, reason: "in_progress" });
    await finishTelegramUpdate(db, 5001, "done");
    expect(await claimTelegramUpdate(db, 5001)).toEqual({ accepted: false, reason: "already_done" });
  });

  it("re-claims an update whose handler failed, because an interrupted attempt committed nothing", async () => {
    await claimTelegramUpdate(db, 5002);
    await finishTelegramUpdate(db, 5002, "failed", "SomeError");
    // This is the case that used to be indistinguishable from a success. It
    // has to be retryable, or one transient error loses the action for good.
    expect(await claimTelegramUpdate(db, 5002)).toMatchObject({ accepted: true, attempts: 2 });
  });

  it("re-claims an update whose invocation died holding the lease", async () => {
    const start = Date.now();
    await claimTelegramUpdate(db, 5003, start);
    expect(await claimTelegramUpdate(db, 5003, start + 1000)).toEqual({ accepted: false, reason: "in_progress" });
    expect(await claimTelegramUpdate(db, 5003, start + UPDATE_LEASE_MS + 1000)).toMatchObject({ accepted: true, attempts: 2 });
  });

  it("stops retrying an update that has failed too many times, and leaves it for an operator", async () => {
    await claimTelegramUpdate(db, 5004);
    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS + 2; attempt += 1) {
      await finishTelegramUpdate(db, 5004, "failed", "SomeError");
      await claimTelegramUpdate(db, 5004);
    }
    expect(await claimTelegramUpdate(db, 5004)).toEqual({ accepted: false, reason: "exhausted" });
    const [row] = await rows("SELECT state, attempts FROM hq_telegram_updates WHERE update_id = 5004");
    expect(row).toMatchObject({ state: "failed", attempts: MAX_UPDATE_ATTEMPTS });
  });

  it("holds a Telegram update id larger than a safe integer would survive", async () => {
    // Telegram ids are 64 bit. The column is bigint and the text cast is what
    // keeps it out of a JavaScript number at every boundary.
    await rows("INSERT INTO hq_telegram_updates(update_id) VALUES (9007199254740993)");
    const [row] = await rows("SELECT update_id::text AS update_id FROM hq_telegram_updates");
    expect(row.update_id).toBe("9007199254740993");
  });
});

describe("callback references", () => {
  const action = (overrides: Partial<Parameters<typeof createBotAction>[1]> = {}) =>
    createBotAction(db, { userId: USER, chatId: CHAT, kind: "project.open", projectId: PROJECT, ...overrides });
  const DRAFT = "00000000-0000-4000-9400-000000000001";

  it("knows which kinds write and which are pinned to a draft", () => {
    expect(isWriteAction("draft.save")).toBe(true);
    expect(isWriteAction("draft.save_over")).toBe(true);
    expect(isWriteAction("projects.page")).toBe(false);
    // Idempotent by construction, so it is not claimed.
    expect(isWriteAction("consent.enable")).toBe(false);
    expect(isDraftAction("draft.cancel")).toBe(true);
    expect(isDraftAction("draft.visibility")).toBe(true);
    expect(isDraftAction("notes.page")).toBe(false);
  });

  it("refuses a reference that belongs to a different account, the same way it refuses one that never existed", async () => {
    const row = await action();
    expect(await readBotAction(db, { id: row.id, userId: OTHER, chatId: CHAT })).toEqual({ ok: false, reason: "not_found" });
    expect(await readBotAction(db, { id: "00000000-0000-4000-8000-00000000dead", userId: USER, chatId: CHAT })).toEqual({ ok: false, reason: "not_found" });
    expect(await readBotAction(db, { id: "not-a-uuid", userId: USER, chatId: CHAT })).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses a reference pressed in a chat it was not minted for", async () => {
    const row = await action();
    expect(await readBotAction(db, { id: row.id, userId: USER, chatId: OTHER_CHAT })).toEqual({ ok: false, reason: "wrong_chat" });
  });

  it("refuses a reference that has expired", async () => {
    const row = await action();
    await rows("UPDATE hq_telegram_actions SET expires_at = now() - interval '1 second' WHERE id = $1::uuid", [row.id]);
    expect(await readBotAction(db, { id: row.id, userId: USER, chatId: CHAT })).toEqual({ ok: false, reason: "expired" });
  });

  it("resolves a reference without consuming it, so an interrupted attempt can be retried", async () => {
    const row = await createBotAction(db, { userId: USER, chatId: CHAT, kind: "draft.save", projectId: PROJECT, draftId: DRAFT, draftRevision: 1 });
    expect((await readBotAction(db, { id: row.id, userId: USER, chatId: CHAT })).ok).toBe(true);
    expect((await readBotAction(db, { id: row.id, userId: USER, chatId: CHAT })).ok).toBe(true);
    const [stored] = await rows("SELECT consumed_at FROM hq_telegram_actions WHERE id = $1::uuid", [row.id]);
    expect(stored.consumed_at).toBeNull();
  });

  it("consumes a writing reference exactly once and records which delivery used it", async () => {
    const row = await createBotAction(db, { userId: USER, chatId: CHAT, kind: "draft.save", projectId: PROJECT, draftId: DRAFT, draftRevision: 1 });
    expect(await consumeBotAction(db, { id: row.id, userId: USER, updateId: 77 })).toBe(true);
    expect(await consumeBotAction(db, { id: row.id, userId: USER, updateId: 78 })).toBe(false);
    expect(await readBotAction(db, { id: row.id, userId: USER, chatId: CHAT })).toEqual({ ok: false, reason: "already_used" });
    const [stored] = await rows("SELECT consumed_update_id::text AS used FROM hq_telegram_actions WHERE id = $1::uuid", [row.id]);
    expect(stored.used).toBe("77");
  });

  it("rolls a consumption back with the transaction it belonged to, so the retry finds the button intact", async () => {
    const row = await createBotAction(db, { userId: USER, chatId: CHAT, kind: "draft.save", projectId: PROJECT, draftId: DRAFT, draftRevision: 1 });
    await expect(
      db.transaction(async (tx) => {
        await consumeBotAction(tx, { id: row.id, userId: USER, updateId: 90 });
        throw new Error("the write after it failed");
      }),
    ).rejects.toThrow();
    expect((await readBotAction(db, { id: row.id, userId: USER, chatId: CHAT })).ok).toBe(true);
  });

  it("leaves a navigation reference pressable, because the keyboard stays in the chat", async () => {
    const row = await action();
    expect((await readBotAction(db, { id: row.id, userId: USER, chatId: CHAT })).ok).toBe(true);
    expect((await readBotAction(db, { id: row.id, userId: USER, chatId: CHAT })).ok).toBe(true);
  });
});

describe("the chat binding", () => {
  it("records the chat without ever turning messaging on", async () => {
    await bindBotChat(db, { userId: USER, telegramUserId: CHAT, chatId: CHAT });
    expect(await botMessagingEnabled(db, USER)).toBe(false);
    expect(await deliverableBotChat(db, USER)).toBeNull();
  });

  it("keeps the decision exactly as it was when the chat changes", async () => {
    await bindBotChat(db, { userId: USER, telegramUserId: CHAT, chatId: CHAT });
    await rows("UPDATE hq_telegram_bot_consent SET messaging_enabled = true, consented_at = now() WHERE user_id = $1", [USER]);
    await bindBotChat(db, { userId: USER, telegramUserId: CHAT, chatId: OTHER_CHAT });
    expect(await deliverableBotChat(db, USER)).toEqual({ userId: USER, chatId: OTHER_CHAT, messagingEnabled: true });
  });

  it("offers nothing to deliver into when messaging is off, even with a chat on file", async () => {
    await bindBotChat(db, { userId: USER, telegramUserId: CHAT, chatId: CHAT });
    await rows("UPDATE hq_telegram_bot_consent SET messaging_enabled = true WHERE user_id = $1", [USER]);
    expect(await deliverableBotChat(db, USER)).not.toBeNull();
    await rows("UPDATE hq_telegram_bot_consent SET messaging_enabled = false, revoked_at = now() WHERE user_id = $1", [USER]);
    expect(await deliverableBotChat(db, USER)).toBeNull();
  });
});

describe("drafts", () => {
  const draft = {
    userId: USER, chatId: CHAT, step: "awaiting_text" as const, projectId: PROJECT, hackathonId: 1,
    periodId: null, entryId: null, expectedVersion: null, visibility: "shared" as const, body: null,
  };

  it("keeps one draft per chat, and gives the replacement a new identity", async () => {
    const first = await startBotDraft(db, draft);
    const second = await startBotDraft(db, { ...draft, step: "preview", body: "second" });
    expect(await rows("SELECT user_id FROM hq_telegram_drafts")).toHaveLength(1);
    // A new composing session, so every button rendered from the first one is
    // dead rather than merely old.
    expect(second.id).not.toBe(first.id);
    expect(second.revision).toBe(1);
    expect(await readBotDraft(db, { userId: USER, chatId: CHAT })).toMatchObject({ step: "preview", body: "second" });
  });

  it("retires the previous draft's buttons when a new one replaces it", async () => {
    const first = await startBotDraft(db, draft);
    await createBotAction(db, { userId: USER, chatId: CHAT, kind: "draft.save", draftId: first.id, draftRevision: first.revision });
    await createBotAction(db, { userId: USER, chatId: CHAT, kind: "menu" });
    await startBotDraft(db, draft);
    // The draft-bound button is gone; the navigation one is untouched.
    const remaining = await rows("SELECT kind FROM hq_telegram_actions");
    expect(remaining).toEqual([{ kind: "menu" }]);
  });

  it("bumps the revision on every change, keeping the same composing session", async () => {
    const first = await startBotDraft(db, draft);
    const typed = await advanceBotDraft(db, { userId: USER, chatId: CHAT, draftId: first.id, expectedRevision: first.revision, step: "preview", body: "typed" });
    expect(typed).toMatchObject({ id: first.id, revision: 2, step: "preview", body: "typed" });
    const shared = await advanceBotDraft(db, { userId: USER, chatId: CHAT, draftId: first.id, expectedRevision: 2, visibility: "sensitive" });
    expect(shared).toMatchObject({ id: first.id, revision: 3, visibility: "sensitive", body: "typed" });
  });

  it("refuses an advance from a revision that has already moved on", async () => {
    const first = await startBotDraft(db, draft);
    await advanceBotDraft(db, { userId: USER, chatId: CHAT, draftId: first.id, expectedRevision: 1, body: "one" });
    expect(await advanceBotDraft(db, { userId: USER, chatId: CHAT, draftId: first.id, expectedRevision: 1, body: "two" })).toBeNull();
  });

  it("claims a draft generation exactly once, so two buttons for one save cannot both win", async () => {
    const first = await startBotDraft(db, { ...draft, step: "preview", body: "one logical update" });
    expect(await claimBotDraft(db, { userId: USER, chatId: CHAT, draftId: first.id, expectedRevision: first.revision })).toMatchObject({ body: "one logical update" });
    expect(await claimBotDraft(db, { userId: USER, chatId: CHAT, draftId: first.id, expectedRevision: first.revision })).toBeNull();
  });

  it("gives the draft back when the transaction that claimed it rolls back", async () => {
    const first = await startBotDraft(db, { ...draft, step: "preview", body: "kept" });
    await expect(
      db.transaction(async (tx) => {
        await claimBotDraft(tx, { userId: USER, chatId: CHAT, draftId: first.id, expectedRevision: first.revision });
        throw new Error("the reporting write refused");
      }),
    ).rejects.toThrow();
    // This is what lets a refused save keep the person's words on screen.
    expect(await readBotDraft(db, { userId: USER, chatId: CHAT })).toMatchObject({ id: first.id, revision: first.revision, body: "kept" });
  });

  it("never returns an expired draft, whatever is still in the table", async () => {
    const base = Date.now();
    await startBotDraft(db, draft, base);
    expect(await readBotDraft(db, { userId: USER, chatId: CHAT }, base + DRAFT_TTL_MS - 1000)).not.toBeNull();
    expect(await readBotDraft(db, { userId: USER, chatId: CHAT }, base + DRAFT_TTL_MS + 1000)).toBeNull();
  });

  it("clears the draft and its buttons together", async () => {
    const first = await startBotDraft(db, draft);
    await createBotAction(db, { userId: USER, chatId: CHAT, kind: "draft.save", draftId: first.id, draftRevision: first.revision });
    await clearBotDraft(db, { userId: USER, chatId: CHAT });
    expect(await readBotDraft(db, { userId: USER, chatId: CHAT })).toBeNull();
    expect(await rows("SELECT id FROM hq_telegram_actions WHERE draft_id IS NOT NULL")).toHaveLength(0);
  });
});

describe("the outgoing queue", () => {
  it("writes one row per event however often the same key is enqueued", async () => {
    const first = await enqueueBotMessage(db, { chatId: CHAT, userId: USER, kind: "update.saved", body: "Saved.", dedupeKey: "entry:abc:v1" });
    const second = await enqueueBotMessage(db, { chatId: CHAT, userId: USER, kind: "update.saved", body: "Saved.", dedupeKey: "entry:abc:v1" });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await rows("SELECT id FROM hq_telegram_outgoing")).toHaveLength(1);
  });
});

describe("retention", () => {
  it("removes the state that has done its job and keeps the rest", async () => {
    const now = Date.now();
    await startBotDraft(db, {
      userId: USER, chatId: CHAT, step: "awaiting_text", projectId: PROJECT, hackathonId: 1,
      periodId: null, entryId: null, expectedVersion: null, visibility: "shared", body: "left overnight",
    }, now - DRAFT_TTL_MS - 60_000);
    await createBotAction(db, { userId: USER, chatId: CHAT, kind: "menu" }, now - 48 * 60 * 60_000);
    await claimTelegramUpdate(db, 6001);
    await finishTelegramUpdate(db, 6001, "done");
    await rows("UPDATE hq_telegram_updates SET received_at = now() - interval '30 days'");
    await enqueueBotMessage(db, { chatId: CHAT, userId: USER, kind: "update.saved", body: "Saved.", dedupeKey: "old" });
    await rows("UPDATE hq_telegram_outgoing SET state='sent', created_at = now() - interval '200 days'");
    // One of each that is still live, so the sweep is shown to be selective.
    await createBotAction(db, { userId: USER, chatId: CHAT, kind: "menu" }, now);
    await claimTelegramUpdate(db, 6002);

    const purged = await purgeExpiredBotState(db, now);
    expect(purged).toEqual({ drafts: 1, actions: 1, receipts: 1, deliveries: 1 });
    expect(await rows("SELECT id FROM hq_telegram_actions")).toHaveLength(1);
    expect(await rows("SELECT update_id FROM hq_telegram_updates")).toHaveLength(1);
    expect(await rows("SELECT user_id FROM hq_telegram_drafts")).toHaveLength(0);
  });

  it("never removes a message that is still waiting to be sent", async () => {
    await enqueueBotMessage(db, { chatId: CHAT, userId: USER, kind: "update.saved", body: "Saved.", dedupeKey: "waiting" });
    await rows("UPDATE hq_telegram_outgoing SET created_at = now() - interval '400 days'");
    expect((await purgeExpiredBotState(db)).deliveries).toBe(0);
    expect(await rows("SELECT id FROM hq_telegram_outgoing")).toHaveLength(1);
  });
});
