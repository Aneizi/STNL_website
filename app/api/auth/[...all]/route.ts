import { toNextJsHandler } from "better-auth/next-js";
import { getAuth, MemberAuthUnavailableError } from "@/lib/hq/member-auth";
import { withMemberEmailDelivery } from "@/lib/hq/member-auth-delivery";

export const runtime = "nodejs";

async function handle(request: Request) {
  try {
    const handler = toNextJsHandler(getAuth());
    return withMemberEmailDelivery(() => request.method === "GET" ? handler.GET(request) : handler.POST(request));
  } catch (error) {
    if (!(error instanceof MemberAuthUnavailableError)) throw error;
    return Response.json({ code: "AUTH_UNAVAILABLE", message: error.message }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export const GET = handle;
export const POST = handle;
