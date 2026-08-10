import { NextResponse, type NextRequest } from "next/server";

// Optimistic gate for /hq: bounce cookie-less visitors to the login screen.
// This is UX only — the real auth boundary is requireUser() in every /hq
// page, server action, and route handler (proxies can be bypassed).
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/hq/login") return NextResponse.next();
  if (!request.cookies.get("hq_session")?.value) {
    return NextResponse.redirect(new URL("/hq/login", request.nextUrl));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/hq/:path*"],
};
