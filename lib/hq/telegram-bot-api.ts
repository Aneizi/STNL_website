import "server-only";

/**
 * Telegram transport only; message composition and durable state live elsewhere.
 * Request URLs contain the bot token and must never be logged. Provider errors
 * are delivery diagnostics for operators, never text to send into a chat.
 */

/** How long a single Telegram call may take before it is abandoned as uncertain. */
export const TELEGRAM_REQUEST_TIMEOUT_MS = 8_000;

/**
 * Refuse oversized HTML instead of slicing tags or entities. The view's
 * packMessages owns splitting; a transport refusal is a permanent failure.
 */
const TELEGRAM_MESSAGE_LIMIT = 4096;

export type TelegramBotConfig = {
  token: string;
  /**
   * Required X-Telegram-Bot-Api-Secret-Token value. Missing or invalid secrets
   * disable the webhook rather than leaving an unauthenticated write endpoint.
   */
  webhookSecret: string;
  apiBase: string;
};

const DEFAULT_API_BASE = "https://api.telegram.org";

/**
 * Both token and webhook secret are required. Validate the secret's Telegram
 * alphabet and a 16–256 character length before considering the bot configured.
 */
export function telegramBotConfig(env: Record<string, string | undefined> = process.env): TelegramBotConfig | null {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!token || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  if (!webhookSecret || !/^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret)) return null;
  const apiBase = env.TELEGRAM_API_BASE?.trim() || DEFAULT_API_BASE;
  return { token, webhookSecret, apiBase };
}

export const isTelegramBotConfigured = (env?: Record<string, string | undefined>): boolean => telegramBotConfig(env) !== null;

/** Whether a failure is worth trying again. A blocked bot or a bad request is not. */
export type TelegramSendOutcome =
  | { ok: true; messageId: number | null }
  | { ok: false; retryable: boolean; code: string; detail: string | null; retryAfterSeconds?: number };

export type OutgoingMessage = {
  chatId: string;
  /** Update this bot message in place instead of adding another message to the chat. */
  editMessageId?: number;
  text: string;
  /** Inline keyboard, already built by the view. Passed through untouched. */
  replyMarkup?: unknown;
  /** Set for every message this bot sends; the view escapes every interpolated value. */
  parseMode?: "HTML";
  disableWebPagePreview?: boolean;
};

/** What the flow needs from a transport. The tests supply their own, which is why nothing below is imported by the flow. */
export interface TelegramSender {
  sendMessage(message: OutgoingMessage): Promise<TelegramSendOutcome>;
  /** Telegram requires every callback query to be answered, or the client shows a spinner until it times out. */
  answerCallbackQuery(input: { callbackQueryId: string; text?: string; showAlert?: boolean }): Promise<void>;
}

/** Telegram's own response envelope, read for the two fields that matter and nothing else. */
type TelegramResponse = { ok?: boolean; result?: { message_id?: number }; description?: string; error_code?: number; parameters?: { retry_after?: number } };

async function call(config: TelegramBotConfig, method: string, body: unknown): Promise<{ status: number; payload: TelegramResponse | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.apiBase}/bot${config.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let payload: TelegramResponse | null = null;
    try {
      payload = (await response.json()) as TelegramResponse;
    } catch {
      payload = null;
    }
    return { status: response.status, payload };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Definite permanent refusals: bad requests, credentials, blocked bot or missing
 * chat. Retrying these cannot deliver the message.
 */
const PERMANENT_STATUS = new Set([400, 401, 403, 404]);

/** The live transport. Built per call rather than kept, so a rotated token takes effect without a restart. */
export function telegramSender(config: TelegramBotConfig): TelegramSender {
  return {
    async sendMessage(message) {
      if (message.text.length > TELEGRAM_MESSAGE_LIMIT) {
        return { ok: false, retryable: false, code: "message_too_long", detail: `${message.text.length} characters` };
      }
      try {
        const editing = message.editMessageId !== undefined;
        const { status, payload } = await call(config, editing ? "editMessageText" : "sendMessage", {
          chat_id: message.chatId,
          ...(editing ? { message_id: message.editMessageId } : {}),
          text: message.text,
          ...(message.parseMode ? { parse_mode: message.parseMode } : {}),
          ...(message.replyMarkup || editing ? { reply_markup: message.replyMarkup ?? { inline_keyboard: [] } } : {}),
          link_preview_options: { is_disabled: message.disableWebPagePreview !== false },
        });
        if (status >= 200 && status < 300 && payload?.ok) {
          return { ok: true, messageId: payload.result?.message_id ?? null };
        }
        // A redelivery may repeat an edit Telegram already applied.
        if (editing && status === 400 && payload?.description?.toLowerCase().includes("message is not modified")) {
          return { ok: true, messageId: message.editMessageId! };
        }
        // Only these definite refusals allow a new message. Timeouts and
        // rate limits must retry the edit, or they would create duplicates.
        const unavailable = editing && status === 400 && /message to edit not found|message can't be edited/i.test(payload?.description ?? "");
        return {
          ok: false,
          retryable: !PERMANENT_STATUS.has(status),
          code: unavailable ? "edit_unavailable" : `telegram_${status}`,
          // Telegram's words, kept for an operator to read on the delivery
          // row. Never rendered into a chat.
          detail: payload?.description ?? null,
          ...(payload?.parameters?.retry_after ? { retryAfterSeconds: payload.parameters.retry_after } : {}),
        };
      } catch (error) {
        // A timeout or a network failure: delivery is UNKNOWN, not failed.
        // The caller records it as uncertain rather than claiming either.
        return { ok: false, retryable: true, code: error instanceof Error && error.name === "AbortError" ? "timeout" : "network", detail: null };
      }
    },
    async answerCallbackQuery(input) {
      try {
        await call(config, "answerCallbackQuery", {
          callback_query_id: input.callbackQueryId,
          ...(input.text ? { text: input.text.slice(0, 200) } : {}),
          ...(input.showAlert ? { show_alert: true } : {}),
        });
      } catch {
        // Answering is a courtesy to the client's spinner. Failing to answer
        // never changes what was saved, and must never fail the update.
      }
    },
  };
}
