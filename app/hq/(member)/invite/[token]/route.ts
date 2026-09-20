import { headers } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { builderDatabase } from "@/lib/hq/builder-db";
import { inviteContinuationCookieOptions, INVITE_CONTINUATION_COOKIE } from "@/lib/hq/invite-continuation";
import { exchangeCaptainInvitationToken } from "@/lib/hq/invite-exchange";
import { currentMember } from "@/lib/hq/member-auth";
import { INVITE_CONTINUE_PATH } from "@/lib/hq/member-routes";

export const dynamic = "force-dynamic";

// Step 1 of the Captain invitation flow (docs/hq's T4.3): the token in this
// address is a bearer secret, so a GET here must never consume it — a link
// preview, a prefetch and a crawler all get exactly the same redirect and no
// state change as a real visitor. This handler renders nothing itself; it
// exchanges the token for a continuation (lib/hq/invite-exchange.ts) and
// redirects to the tokenless continuation page, which does the rest.
//
// currentMember() is the session check every /hq surface carries
// (tests/hq/auth-boundary.test.ts); this step's own behaviour never branches
// on its result — a signed-in and a signed-out visitor exchange a token
// identically. Identity only starts to matter on the continuation page.
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  await currentMember();
  const { token } = await params;
  const headerList = await headers();
  // Vercel sets x-real-ip itself, so it cannot be client-spoofed there
  // (matches lib/hq/actions/auth.ts); anywhere else, unattributable traffic
  // shares one rate-limit bucket.
  const ip = headerList.get("x-real-ip") ?? headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const { continuationId } = await exchangeCaptainInvitationToken(builderDatabase(), { token, ip });
  const response = NextResponse.redirect(new URL(INVITE_CONTINUE_PATH, request.nextUrl));
  if (continuationId) {
    response.cookies.set(INVITE_CONTINUATION_COOKIE, continuationId, inviteContinuationCookieOptions());
  } else {
    // A failed exchange (unknown token, or a rate-limited address) must not
    // leave a *previous* continuation in place: without this, a stale
    // continuation cookie from an earlier, successful visit would survive
    // and the continuation page would silently act on that old invitation
    // instead of landing on the invalid-link outcome this token deserves.
    // Same path as the set above, or the browser treats it as a different
    // cookie and the original is never actually cleared.
    response.cookies.delete({ name: INVITE_CONTINUATION_COOKIE, path: inviteContinuationCookieOptions().path });
  }
  return response;
}
