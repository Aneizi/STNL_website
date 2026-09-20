import "server-only";
import { z } from "zod";
import { builderDatabase, type BuilderDatabase } from "./builder-db";
import { telegramBotConfig, telegramSender, TELEGRAM_REQUEST_TIMEOUT_MS, type TelegramBotConfig, type TelegramSender } from "./telegram-bot-api";
import { handleTelegramUpdate, type TelegramUpdate } from "./telegram-bot";
import { claimTelegramUpdate, finishTelegramUpdate, flushBotMessages } from "./telegram-bot-store";
import { inlineKeyboard } from "./telegram-bot-view";

/**
 * The webhook's own rules, apart from the route handler so that every one of
 * them can be tested without a server.
 *
 * Three things protect this endpoint, and they are independent of each other:
 *
 * 1. **A dedicated secret header.** Telegram echoes the value given to
 *    setWebhook in `X-Telegram-Bot-Api-Secret-Token` on every delivery, and
 *    it is compared in constant time. It is not an admin session and grants
 *    nothing beyond "this request came from our own webhook registration";
 *    the plan's "Protect the bot webhook and job endpoint independently. An
 *    authenticated bot request is not an admin session."
 * 2. **A bounded body.** A webhook is an unauthenticated-until-verified POST
 *    from the public internet, so the body is read with a hard cap before it
 *    is parsed at all.
 * 3. **A validated payload.** The schema below names every field the bot
 *    reads and ignores the rest of Telegram's envelope. Nothing is passed
 *    through untyped, and nothing in a payload is ever an actor id: the
 *    account comes from the Telegram identity row, looked up on every update.
 */

/** Telegram's documented maximum is well under this; anything larger is refused without being buffered. */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

/**
 * Reads a request body, in bytes, and stops as soon as the cap is passed.
 *
 * `request.text()` would buffer the whole thing first and only then let it be
 * measured, which is no cap at all against a body that arrives without a
 * Content-Length, and it measures UTF-16 code units rather than bytes. This
 * reads the stream and abandons it the moment the byte count is exceeded, so
 * an oversized body is never held in memory whole.
 */
async function readBoundedBody(request: Request, limit = MAX_WEBHOOK_BODY_BYTES): Promise<{ ok: true; text: string } | { ok: false; reason: "too_large" | "unreadable" }> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return { ok: false, reason: "too_large" };
  const body = request.body;
  if (!body) {
    // No stream to read (a synthesised request in a test, or an empty body).
    try {
      const text = await request.text();
      return new TextEncoder().encode(text).length > limit ? { ok: false, reason: "too_large" } : { ok: true, text };
    } catch {
      return { ok: false, reason: "unreadable" };
    }
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(joined) };
}

export const SECRET_HEADER = "x-telegram-bot-api-secret-token";

/**
 * Timing-safe comparison of two short ASCII strings, without a Node crypto
 * import in a module that tests exercise directly. Lengths are compared first
 * because they are not secret, then every character is compared and the
 * results accumulated so the loop cannot exit early.
 */
export function secretMatches(expected: string, received: string | null): boolean {
  if (typeof received !== "string" || received.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) diff |= expected.charCodeAt(index) ^ received.charCodeAt(index);
  return diff === 0;
}

const chat = z.object({ id: z.union([z.number(), z.string()]), type: z.string().optional() }).passthrough();
const user = z.object({ id: z.union([z.number(), z.string()]), is_bot: z.boolean().optional() }).passthrough();
const message = z
  .object({
    message_id: z.number().int().positive().optional(),
    chat: chat.optional(),
    from: user.optional(),
    text: z.string().max(8192).optional(),
  })
  .passthrough();

const telegramUpdateSchema = z
  .object({
    update_id: z.number().int(),
    message: message.optional(),
    edited_message: message.optional(),
    channel_post: message.optional(),
    callback_query: z
      .object({ id: z.string().max(128), from: user.optional(), data: z.string().max(128).optional(), message: message.optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

type WebhookResult =
  | { status: 200; body: { ok: true; outcome: string } }
  | { status: 401 | 413 | 400 | 503; body: { ok: false; error: string } }
  | { status: 500 | 502; body: { ok: false; error: string } };

type WebhookDependencies = {
  db?: BuilderDatabase;
  config?: TelegramBotConfig | null;
  sender?: TelegramSender;
  now?: number;
  hqOrigin?: string | null;
};

/**
 * Handles one webhook request end to end.
 *
 * The order is deliberate. Authentication and the size cap come before any
 * parsing; the update id is claimed durably before the handler runs, so a
 * Telegram retry of a delivery that already succeeded is answered 200 without
 * running anything; the handler's own writes commit before anything is sent;
 * and the queue is drained afterwards, so a failed send can never roll back a
 * saved update.
 *
 * A handler that throws is answered 500 and its receipt is RELEASED, not
 * closed, so Telegram's redelivery of the same update is picked up and
 * finished. That is only safe because the handler's writes are atomic: the
 * callback consumption, the draft claim, the reporting write and the durable
 * confirmation all commit in one transaction, so an interrupted attempt
 * committed nothing and the retry has nothing to duplicate. Treating a
 * crashed attempt as a completed duplicate is what silently lost a Captain's
 * update to one transient database error.
 *
 * `claimTelegramUpdate` is what tells the three cases apart: finished, in
 * flight under a live lease, and interrupted. Only the last is re-run, and
 * only up to `MAX_UPDATE_ATTEMPTS`.
 */
export async function handleTelegramWebhookRequest(request: Request, dependencies: WebhookDependencies = {}): Promise<WebhookResult> {
  const deadlineMs = Date.now() + 55_000;
  const config = dependencies.config !== undefined ? dependencies.config : telegramBotConfig();
  // No credentials is not an error, it is "this deployment has no bot". The
  // same honest unavailability /api/auth/* answers when Better Auth is
  // unconfigured, and the reason missing Telegram credentials never block
  // anything else.
  if (!config) return { status: 503, body: { ok: false, error: "The Telegram bot is not configured." } };
  if (!secretMatches(config.webhookSecret, request.headers.get(SECRET_HEADER))) {
    return { status: 401, body: { ok: false, error: "Unauthorized" } };
  }

  const read = await readBoundedBody(request);
  if (!read.ok) {
    return read.reason === "too_large"
      ? { status: 413, body: { ok: false, error: "Payload too large" } }
      : { status: 400, body: { ok: false, error: "Unreadable body" } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { status: 400, body: { ok: false, error: "Malformed payload" } };
  }
  const update = telegramUpdateSchema.safeParse(parsed);
  if (!update.success) return { status: 400, body: { ok: false, error: "Malformed payload" } };

  const db = dependencies.db ?? builderDatabase();
  const now = dependencies.now ?? Date.now();
  const claim = await claimTelegramUpdate(db, update.data.update_id, now);
  if (!claim.accepted) {
    // An overlapping retry must remain retryable: the invocation holding
    // the lease could still fail. A 200 here would tell Telegram to forget it.
    if (claim.reason === "in_progress") return { status: 503, body: { ok: false, error: "Update still processing" } };
    // `already_done` is finished work.
    // `exhausted` is a row an operator should look at, and answering 200
    // stops Telegram retrying something that has already failed five times.
    return { status: 200, body: { ok: true, outcome: claim.reason } };
  }

  const sender = dependencies.sender ?? telegramSender(config);
  try {
    const result = await handleTelegramUpdate(update.data as TelegramUpdate, {
      db,
      now,
      retry: claim.attempts > 1,
      ...(dependencies.hqOrigin !== undefined ? { hqOrigin: dependencies.hqOrigin } : {}),
    });
    // Menus, lists and previews are sent directly rather than queued, because
    // they carry no news and repeat cheaply. That is only honest if a failed
    // send leaves the update REDELIVERABLE: acknowledging a preview Telegram
    // never accepted would consume the press, advance the draft and leave
    // somebody looking at a chat with no controls in it. So a retryable
    // failure marks the receipt failed and answers non-2xx, which is
    // Telegram's own signal to deliver the update again, and the handler
    // rebuilds the same reply from state it never destroyed.
    let retryableSendFailure: string | null = null;
    if (result.answer && Date.now() + TELEGRAM_REQUEST_TIMEOUT_MS < deadlineMs) {
      await sender.answerCallbackQuery({ callbackQueryId: result.answer.callbackQueryId, ...(result.answer.text ? { text: result.answer.text } : {}) });
    }
    for (const reply of result.replies) {
      if (Date.now() + TELEGRAM_REQUEST_TIMEOUT_MS >= deadlineMs) {
        retryableSendFailure = "reply_budget";
        break;
      }
      const target = update.data.callback_query?.message?.message_id;
      const outgoing = {
        chatId: reply.chatId,
        text: reply.text,
        parseMode: "HTML" as const,
        ...(target && !reply.newMessage ? { editMessageId: target } : {}),
        ...(reply.keyboard.length ? { replyMarkup: inlineKeyboard(reply.keyboard) } : {}),
      };
      let outcome = await sender.sendMessage(outgoing);
      if (!outcome.ok && outcome.code === "edit_unavailable") {
        if (Date.now() + TELEGRAM_REQUEST_TIMEOUT_MS >= deadlineMs) {
          retryableSendFailure = "reply_budget";
          break;
        }
        outcome = await sender.sendMessage({ ...outgoing, editMessageId: undefined });
      }
      if (!outcome.ok && outcome.retryable) {
        retryableSendFailure = outcome.code;
        break;
      }
      // A permanent refusal (a blocked bot, a chat that is gone) is not worth
      // a redelivery: the same send would fail the same way forever.
      if (!outcome.ok) console.warn("Telegram reply refused", { updateId: update.data.update_id, code: outcome.code });
    }
    if (result.queued) await flushBotMessages(db, sender, { deadlineMs, ...(dependencies.now != null ? { now: dependencies.now } : {}) });
    if (retryableSendFailure) {
      await finishTelegramUpdate(db, update.data.update_id, "failed", retryableSendFailure, claim.attempts);
      return { status: 502, body: { ok: false, error: "Reply could not be delivered" } };
    }
    await finishTelegramUpdate(db, update.data.update_id, "done", undefined, claim.attempts);
    return { status: 200, body: { ok: true, outcome: result.outcome } };
  } catch (error) {
    // The code only. Never the update's text, never a name, never a token:
    // "Redact tokens and update text from routine logs."
    const code = error instanceof Error ? error.name : "error";
    await finishTelegramUpdate(db, update.data.update_id, "failed", code, claim.attempts);
    console.error("Telegram webhook handler failed", { updateId: update.data.update_id, code });
    // The receipt is released rather than closed, so Telegram's retry of this
    // same update is picked up and finished. That is safe because the
    // handler's writes are atomic: an interrupted attempt committed nothing,
    // so there is nothing for the retry to duplicate.
    return { status: 500, body: { ok: false, error: "Update could not be handled" } };
  }
}
