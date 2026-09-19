import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

export type MemberEmailDeliveryFailure = "EMAIL_DELIVERY_FAILED" | "EMAIL_DAILY_QUOTA_EXCEEDED";

const delivery = new AsyncLocalStorage<{ failure: MemberEmailDeliveryFailure | null }>();

export function memberEmailDeliveryFailed(failure: MemberEmailDeliveryFailure = "EMAIL_DELIVERY_FAILED") {
  const request = delivery.getStore();
  if (request) request.failure = failure;
}

/** Better Auth absorbs sender errors. Keep the HTTP result honest per request. */
export async function withMemberEmailDelivery(handler: () => Promise<Response>): Promise<Response> {
  return delivery.run({ failure: null }, async () => {
    const response = await handler();
    const failure = delivery.getStore()?.failure;
    if (!failure || !response.ok) return response;
    const dailyQuota = failure === "EMAIL_DAILY_QUOTA_EXCEEDED";
    return Response.json(
      { code: failure, message: dailyQuota ? "We've reached our daily email limit. Please try again tomorrow." : "We could not send your code. Please try again shortly." },
      { status: dailyQuota ? 429 : 503, headers: { "Cache-Control": "no-store" } },
    );
  });
}
