import "server-only";

/**
 * The Telegram Bot API transport, and nothing else.
 *
 * Kept apart from `lib/hq/telegram-bot.ts` (which decides what to say) and
 * `lib/hq/telegram-bot-store.ts` (which remembers it) so that the flow can be
 * tested against a fake sender without a token, a network call or a bot: the
 * plan's "Missing Telegram credentials must not block implementation", and
 * the same shape `lib/hq/member-auth-delivery.ts` uses for Resend.
 *
 * Two rules live here because this is the only module that ever holds the
 * token:
 *
 * 1. **The token is in the URL of every Telegram request** (`/bot<token>/...`,
 *    the API's own scheme). Nothing here logs a URL, and `redactBotUrl` is
 *    exported so that anything which must mention one redacts it first. The
 *    plan: "Do not ship a bot token in a URL that application logging
 *    records."
 * 2. **Telegram's own error text is data, never a message.** It is stored on
 *    the delivery row for an operator and returned to the caller as a code;
 *    it is never shown in a chat and never concatenated into one.
 */

/** How long a single Telegram call may take before it is abandoned as uncertain. */
export const TELEGRAM_REQUEST_TIMEOUT_MS = 8_000;

/**
 * Telegram's own cap on a sendMessage text.
 *
 * Splitting belongs to the view, which is the only layer that knows where a
 * message may be cut: this one sees a serialized HTML string and cannot tell
 * an entity from a tag from a sentence. Slicing here used to cut `&amp;` in
 * half, drop a closing `</blockquote>` and take the audience line with it, so
 * the transport now REFUSES an over-length message rather than corrupting it.
 * `packMessages` in ./telegram-bot-view is what makes that unreachable, and
 * a refusal is a permanent, visible failure rather than a silent one.
 */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

export type TelegramBotConfig = {
  token: string;
  /**
   * The value Telegram echoes in `X-Telegram-Bot-Api-Secret-Token` on every
   * webhook delivery, set once with setWebhook. Required, not optional: an
   * unauthenticated webhook is an open write endpoint, so a deployment
   * without this secret serves no webhook at all.
   */
  webhookSecret: string;
  apiBase: string;
};

const DEFAULT_API_BASE = "https://api.telegram.org";

/**
 * The bot's credentials, or null when either is missing or unusable.
 *
 * Both are required together. A token with no webhook secret could still send
 * messages, but the route that receives them would have nothing to
 * authenticate with, so the honest answer for a half-configured deployment is
 * "not configured" rather than a half-open one.
 *
 * The secret is held to Telegram's own allowed alphabet (A-Z, a-z, 0-9, _ and
 * -, 1 to 256 characters) and to a length that is worth having, so a
 * placeholder left in an environment file fails here rather than in a
 * comparison against a header.
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

/**
 * A Telegram API URL with the bot token replaced. Every diagnostic that
 * mentions a URL passes through this first; there is no code path that logs
 * an unredacted one.
 */
export function redactBotUrl(url: string): string {
  return String(url ?? "").replace(/\/bot\d+:[A-Za-z0-9_-]+/g, "/bot<redacted>");
}

/** Whether a failure is worth trying again. A blocked bot or a bad request is not. */
export type TelegramSendOutcome =
  | { ok: true; messageId: number | null }
  | { ok: false; retryable: boolean; code: string; detail: string | null; retryAfterSeconds?: number };

export type OutgoingMessage = {
  chatId: string;
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
 * HTTP statuses that are worth another attempt. 403 is the blocked bot and
 * 400 a malformed request or a chat that no longer exists: retrying either
 * would spam Telegram for a message that can never be delivered, which is the
 * plan's "Avoid aggressive retries".
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
        const { status, payload } = await call(config, "sendMessage", {
          chat_id: message.chatId,
          text: message.text,
          ...(message.parseMode ? { parse_mode: message.parseMode } : {}),
          ...(message.replyMarkup ? { reply_markup: message.replyMarkup } : {}),
          link_preview_options: { is_disabled: message.disableWebPagePreview !== false },
        });
        if (status >= 200 && status < 300 && payload?.ok) {
          return { ok: true, messageId: payload.result?.message_id ?? null };
        }
        return {
          ok: false,
          retryable: !PERMANENT_STATUS.has(status),
          code: `telegram_${status}`,
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
