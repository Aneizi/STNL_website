import { handleTelegramWebhookRequest } from "@/lib/hq/telegram-webhook";

/**
 * The STNL Telegram bot's webhook.
 *
 * Deliberately thin: every rule, including the secret header, the size cap,
 * the payload schema, update deduplication and the outgoing queue, lives in
 * `lib/hq/telegram-webhook.ts` so it can be tested without a server. This
 * file exists to be the address Telegram posts to.
 *
 * It is NOT an admin surface and shares nothing with one. It carries no
 * operator session, no member session and no cookie of any kind; the account
 * behind an update comes from the verified Telegram identity row, read on
 * every request.
 */
export const dynamic = "force-dynamic";
// A handler sends a small number of Telegram messages and nothing else. The
// Vercel Hobby ceiling is 60 seconds; a normal update finishes in well under
// one.
export const maxDuration = 30;

export async function POST(request: Request) {
  const result = await handleTelegramWebhookRequest(request);
  return Response.json(result.body, { status: result.status });
}

/**
 * Telegram only ever POSTs here. A GET is answered without saying whether a
 * bot is configured, so the address is not a probe for whether this
 * deployment has one.
 */
export function GET() {
  return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
}
