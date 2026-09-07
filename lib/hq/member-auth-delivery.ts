import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

const delivery = new AsyncLocalStorage<{ failed: boolean }>();

export function memberEmailDeliveryFailed() {
  const request = delivery.getStore();
  if (request) request.failed = true;
}

/** Better Auth absorbs sender errors. Keep the HTTP result honest per request. */
export async function withMemberEmailDelivery(handler: () => Promise<Response>): Promise<Response> {
  return delivery.run({ failed: false }, async () => {
    const response = await handler();
    if (!delivery.getStore()?.failed || !response.ok) return response;
    return Response.json(
      { code: "EMAIL_DELIVERY_FAILED", message: "We could not send your code. Please try again shortly." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  });
}
