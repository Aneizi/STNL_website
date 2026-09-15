// The webhook's own protections, against the real schema on PGlite.
//
// Every one of these is a rule the plan states for the endpoint rather than
// for the bot: a dedicated secret header, a bounded body, a validated
// payload, durable deduplication of Telegram's retries, and an acknowledgement
// that happens only after the update has been durably accepted.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ builderDatabase: vi.fn() }));
vi.mock("@/lib/hq/builder-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hq/builder-db")>()),
  builderDatabase: mocks.builderDatabase,
}));

import type { BuilderDatabase } from "@/lib/hq/builder-db";
import { redactBotUrl, telegramBotConfig, type TelegramBotConfig, type TelegramSender } from "@/lib/hq/telegram-bot-api";
import {
  handleTelegramWebhookRequest,
  MAX_WEBHOOK_BODY_BYTES,
  SECRET_HEADER,
  secretMatches,
} from "@/lib/hq/telegram-webhook";
import { createMigratedDatabase, pgliteBuilderDatabase } from "./helpers/db";

const SECRET = "a-fictional-webhook-secret-value";
const CONFIG: TelegramBotConfig = { token: "1234567890:AAfictional-token-value-for-tests", webhookSecret: SECRET, apiBase: "https://api.telegram.invalid" };

let pg: PGlite;
let db: BuilderDatabase;
let sent: { chatId: string; text: string }[];

const sender: TelegramSender = {
  async sendMessage(message) {
    sent.push({ chatId: message.chatId, text: message.text });
    return { ok: true, messageId: 1 };
  },
  async answerCallbackQuery() {},
};

function post(body: unknown, options: { secret?: string | null; contentLength?: number } = {}): Request {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const headers = new Headers({ "content-type": "application/json" });
  if (options.secret !== null) headers.set(SECRET_HEADER, options.secret ?? SECRET);
  if (options.contentLength !== undefined) headers.set("content-length", String(options.contentLength));
  return new Request("https://hq.example.test/api/telegram/webhook", { method: "POST", headers, body: raw });
}

const handle = (request: Request, overrides: Parameters<typeof handleTelegramWebhookRequest>[1] = {}) =>
  handleTelegramWebhookRequest(request, { db, config: CONFIG, sender, hqOrigin: "https://hq.example.test", ...overrides });

async function rows(text: string, values: unknown[] = []) {
  return (await pg.query(text, values)).rows as Record<string, unknown>[];
}

const update = (id: number) => ({ update_id: id, message: { message_id: id, chat: { id: 7000000000777, type: "private" }, from: { id: 7000000000777 }, text: "/start" } });

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = pgliteBuilderDatabase(pg);
  mocks.builderDatabase.mockReturnValue(db);
}, 40_000);

afterAll(async () => { await pg.close(); });

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.builderDatabase.mockReturnValue(db);
  sent = [];
  await pg.exec("DELETE FROM hq_telegram_updates; DELETE FROM hq_telegram_outgoing; DELETE FROM hq_telegram_actions; DELETE FROM hq_telegram_drafts;");
});

describe("credentials", () => {
  it("answers 503 when no bot is configured, without failing anything else", async () => {
    const result = await handle(post(update(1)), { config: null });
    expect(result.status).toBe(503);
    expect(await rows("SELECT update_id FROM hq_telegram_updates")).toHaveLength(0);
  });

  it("requires both the token and the webhook secret before it calls itself configured", () => {
    expect(telegramBotConfig({})).toBeNull();
    expect(telegramBotConfig({ TELEGRAM_BOT_TOKEN: CONFIG.token })).toBeNull();
    expect(telegramBotConfig({ TELEGRAM_WEBHOOK_SECRET: SECRET })).toBeNull();
    expect(telegramBotConfig({ TELEGRAM_BOT_TOKEN: "not-a-token", TELEGRAM_WEBHOOK_SECRET: SECRET })).toBeNull();
    expect(telegramBotConfig({ TELEGRAM_BOT_TOKEN: CONFIG.token, TELEGRAM_WEBHOOK_SECRET: "short" })).toBeNull();
    expect(telegramBotConfig({ TELEGRAM_BOT_TOKEN: CONFIG.token, TELEGRAM_WEBHOOK_SECRET: SECRET })).toMatchObject({ token: CONFIG.token, webhookSecret: SECRET });
  });

  it("never lets a bot token reach a logged URL", () => {
    const url = `https://api.telegram.org/bot${CONFIG.token}/sendMessage`;
    expect(redactBotUrl(url)).toBe("https://api.telegram.org/bot<redacted>/sendMessage");
    expect(redactBotUrl(url)).not.toContain(CONFIG.token);
  });

  it("compares the secret without leaking its length through an early exit", () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches(SECRET, null)).toBe(false);
    expect(secretMatches(SECRET, SECRET.slice(0, -1))).toBe(false);
    expect(secretMatches(SECRET, `${SECRET.slice(0, -1)}x`)).toBe(false);
  });
});

describe("the request itself", () => {
  it("refuses a delivery with no secret header", async () => {
    const result = await handle(post(update(2), { secret: null }));
    expect(result.status).toBe(401);
    expect(await rows("SELECT update_id FROM hq_telegram_updates")).toHaveLength(0);
  });

  it("refuses a delivery with the wrong secret", async () => {
    const result = await handle(post(update(3), { secret: "a-different-fictional-secret-val" }));
    expect(result.status).toBe(401);
  });

  it("refuses an oversized body before reading it", async () => {
    const result = await handle(post(update(4), { contentLength: MAX_WEBHOOK_BODY_BYTES + 1 }));
    expect(result.status).toBe(413);
    expect(await rows("SELECT update_id FROM hq_telegram_updates")).toHaveLength(0);
  });

  it("refuses an oversized body that lied about its length", async () => {
    const result = await handle(post(`{"update_id":5,"pad":"${"x".repeat(MAX_WEBHOOK_BODY_BYTES)}"}`));
    expect(result.status).toBe(413);
  });

  it("refuses a body that is not JSON", async () => {
    expect((await handle(post("not json at all"))).status).toBe(400);
  });

  it("refuses a payload that is not a Telegram update", async () => {
    expect((await handle(post({ hello: "world" }))).status).toBe(400);
    expect((await handle(post({ update_id: "not a number" }))).status).toBe(400);
  });

  it("ignores the parts of a payload the bot does not read", async () => {
    const result = await handle(post({ ...update(6), some_future_field: { nested: true } }));
    expect(result.status).toBe(200);
  });
});

describe("deduplication", () => {
  it("handles an update once and answers a redelivery of the finished one without running it again", async () => {
    const first = await handle(post(update(10)));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, outcome: "not_connected" });
    const delivered = sent.length;

    const second = await handle(post(update(10)));
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, outcome: "already_done" });
    expect(sent.length).toBe(delivered);
    expect(await rows("SELECT update_id FROM hq_telegram_updates")).toHaveLength(1);
  });

  it("records the receipt durably rather than in memory", async () => {
    await handle(post(update(11)));
    const [receipt] = await rows("SELECT update_id::text AS update_id, state FROM hq_telegram_updates");
    expect(receipt).toMatchObject({ update_id: "11", state: "done" });
  });

  it("answers 500 on a handler failure and lets Telegram's retry finish the work", async () => {
    const failing: TelegramSender = {
      async sendMessage() {
        throw Object.assign(new Error("boom"), { name: "SenderFailure" });
      },
      async answerCallbackQuery() {},
    };
    const result = await handle(post(update(12)), { sender: failing });
    expect(result.status).toBe(500);
    const [receipt] = await rows("SELECT state, last_error, attempts FROM hq_telegram_updates");
    expect(receipt).toMatchObject({ state: "failed", last_error: "SenderFailure", attempts: 1 });

    // Telegram retries, and the retry must RUN. Treating a crashed attempt as
    // a finished duplicate is what silently lost the person's action; the
    // handler's writes are atomic, so there is nothing for this to duplicate.
    const retry = await handle(post(update(12)));
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ ok: true, outcome: "not_connected" });
    const [after] = await rows("SELECT state, attempts FROM hq_telegram_updates");
    expect(after).toMatchObject({ state: "done", attempts: 2 });
  });

  it("does not run an update a second invocation is holding right now", async () => {
    const slow: TelegramSender = {
      sendMessage: async () => {
        // While this is in flight, a redelivery arrives.
        const overlapping = await handle(post(update(13)));
        expect(overlapping.body).toMatchObject({ outcome: "in_progress" });
        return { ok: true, messageId: 1 };
      },
      async answerCallbackQuery() {},
    };
    const result = await handle(post(update(13)), { sender: slow });
    expect(result.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it("keeps a reply that Telegram refused retryably redeliverable rather than acknowledging it", async () => {
    const refusing: TelegramSender = {
      async sendMessage() {
        return { ok: false, retryable: true, code: "telegram_500", detail: null };
      },
      async answerCallbackQuery() {},
    };
    const result = await handle(post(update(14)), { sender: refusing });
    // Not 200: a menu or a preview Telegram never accepted must come back,
    // and Telegram only redelivers what it did not get a success for.
    expect(result.status).toBe(502);
    const [receipt] = await rows("SELECT state, last_error FROM hq_telegram_updates");
    expect(receipt).toMatchObject({ state: "failed", last_error: "telegram_500" });

    const retry = await handle(post(update(14)));
    expect(retry.status).toBe(200);
  });

  it("acknowledges a reply Telegram refused permanently, because redelivering it would fail the same way", async () => {
    const blocked: TelegramSender = {
      async sendMessage() {
        return { ok: false, retryable: false, code: "telegram_403", detail: "Forbidden: bot was blocked by the user" };
      },
      async answerCallbackQuery() {},
    };
    const result = await handle(post(update(15)), { sender: blocked });
    expect(result.status).toBe(200);
    const [receipt] = await rows("SELECT state FROM hq_telegram_updates");
    expect(receipt).toMatchObject({ state: "done" });
  });
});

describe("the body cap", () => {
  it("stops reading an oversized body that arrives without a Content-Length", async () => {
    // A streamed body with no length header: `request.text()` would buffer the
    // whole thing before anything could measure it.
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 8192;
        controller.enqueue(new TextEncoder().encode("x".repeat(8192)));
        if (produced > MAX_WEBHOOK_BODY_BYTES * 4) controller.close();
      },
    });
    const request = new Request("https://hq.example.test/api/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", [SECRET_HEADER]: SECRET },
      body: stream,
      // @ts-expect-error duplex is required for a streamed request body in Node
      duplex: "half",
    });
    const result = await handle(request);
    expect(result.status).toBe(413);
    // Abandoned well before the whole stream was produced.
    expect(produced).toBeLessThanOrEqual(MAX_WEBHOOK_BODY_BYTES + 8192);
  });

  it("measures bytes rather than JavaScript string length", async () => {
    // Four bytes each, one UTF-16 pair each: a string-length cap would let
    // roughly twice the intended size through.
    const emoji = "🚀".repeat(Math.ceil(MAX_WEBHOOK_BODY_BYTES / 4));
    const body = JSON.stringify({ update_id: 20, message: { text: emoji } });
    expect(body.length).toBeLessThan(MAX_WEBHOOK_BODY_BYTES);
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(MAX_WEBHOOK_BODY_BYTES);
    const request = new Request("https://hq.example.test/api/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", [SECRET_HEADER]: SECRET },
      body,
    });
    expect((await handle(request)).status).toBe(413);
  });
});
