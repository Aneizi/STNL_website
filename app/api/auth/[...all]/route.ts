import { toNextJsHandler } from "better-auth/next-js";
import { getAuth, MemberAuthUnavailableError } from "@/lib/hq/member-auth";
import { withMemberEmailDelivery } from "@/lib/hq/member-auth-delivery";

export const runtime = "nodejs";

async function handle(request: Request) {
  let response: Response;
  try {
    const handler = toNextJsHandler(getAuth());
    response = await withMemberEmailDelivery(() => request.method === "GET" ? handler.GET(request) : handler.POST(request));
  } catch (error) {
    if (!(error instanceof MemberAuthUnavailableError)) throw error;
    response = Response.json({ code: "AUTH_UNAVAILABLE", message: error.message }, { status: 503 });
  }
  // Include anonymous sessions and failures: neither may be cached as public
  // auth state. Copy headers because provider redirects can be immutable.
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export const GET = handle;
export const POST = handle;
