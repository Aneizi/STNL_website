import { NextResponse, type NextRequest } from "next/server";
import { isMemberPath } from "@/lib/hq/member-routes";

// The proxy's own two exceptions: the operator login, and the retired signup
// URL, which reaches Next's 404 instead of redirecting to login. Every
// member path comes from the one list in lib/hq/member-routes.ts.
const OPERATOR_PUBLIC = ["/hq/admin/login", "/hq/signup"];

// Optimistic gate for /hq: bounce cookie-less visitors to the login screen.
// This is UX only — the real auth boundary is requireUser() in every /hq
// page, server action, and route handler (proxies can be bypassed).
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // Member pages use their own database-backed session and never hq_session.
  if (OPERATOR_PUBLIC.includes(pathname) || isMemberPath(pathname)) return NextResponse.next();
  if (!request.cookies.get("hq_session")?.value) {
    return NextResponse.redirect(new URL("/hq/admin/login", request.nextUrl));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/hq/:path*"],
};
