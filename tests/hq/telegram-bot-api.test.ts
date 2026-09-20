import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { telegramSender } from "@/lib/hq/telegram-bot-api";

const sender = telegramSender({ token: "123:fictional", webhookSecret: "fictional", apiBase: "https://telegram.invalid" });
afterEach(() => vi.unstubAllGlobals());

function respond(status: number, payload: unknown) {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("in-place Telegram delivery", () => {
  it("edits both the text and keyboard of the chosen message", async () => {
    const fetch = respond(200, { ok: true, result: { message_id: 42 } });
    const replyMarkup = { inline_keyboard: [[{ text: "Back", callback_data: "opaque" }]] };
    expect(await sender.sendMessage({ chatId: "77", editMessageId: 42, text: "<b>Projects</b>", parseMode: "HTML", replyMarkup })).toEqual({ ok: true, messageId: 42 });
    expect(fetch.mock.calls[0][0]).toBe("https://telegram.invalid/bot123:fictional/editMessageText");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ chat_id: "77", message_id: 42, text: "<b>Projects</b>", parse_mode: "HTML", reply_markup: replyMarkup, link_preview_options: { is_disabled: true } });
  });

  it("removes old controls when the replacement has no keyboard", async () => {
    const fetch = respond(200, { ok: true, result: { message_id: 42 } });
    await sender.sendMessage({ chatId: "77", editMessageId: 42, text: "Connect your account" });
    expect(JSON.parse(fetch.mock.calls[0][1].body).reply_markup).toEqual({ inline_keyboard: [] });
  });

  it("still sends new messages when no edit target is provided", async () => {
    const fetch = respond(200, { ok: true, result: { message_id: 43 } });
    await sender.sendMessage({ chatId: "77", text: "Send your update" });
    expect(fetch.mock.calls[0][0]).toContain("/sendMessage");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).not.toHaveProperty("message_id");
  });

  it("treats an already-applied edit as success", async () => {
    respond(400, { ok: false, description: "Bad Request: message is not modified: content is unchanged" });
    expect(await sender.sendMessage({ chatId: "77", editMessageId: 42, text: "Projects" })).toEqual({ ok: true, messageId: 42 });
  });

  it.each(["message to edit not found", "message can't be edited"])("allows a fresh menu only for a definite unavailable target: %s", async (description) => {
    respond(400, { ok: false, description: `Bad Request: ${description}` });
    expect(await sender.sendMessage({ chatId: "77", editMessageId: 42, text: "Projects" })).toMatchObject({ ok: false, retryable: false, code: "edit_unavailable" });
  });

  it.each([400, 403, 429, 500])("does not turn other failures into new messages (%i)", async (status) => {
    respond(status, { ok: false, description: "Request refused", parameters: { retry_after: 30 } });
    expect(await sender.sendMessage({ chatId: "77", editMessageId: 42, text: "Projects" })).toMatchObject({ ok: false, retryable: status >= 429, code: `telegram_${status}` });
  });

  it("keeps an uncertain edit retryable without exposing the request URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("https://telegram.invalid/bot123:fictional/editMessageText")));
    expect(await sender.sendMessage({ chatId: "77", editMessageId: 42, text: "Projects" })).toEqual({ ok: false, retryable: true, code: "network", detail: null });
  });
});
