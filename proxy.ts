import { NextResponse, type NextRequest } from "next/server";

// Optimistic gate for /hq: bounce cookie-less visitors to the login screen.
// This is UX only — the real auth boundary is requireUser() in every /hq
// page, server action, and route handler (proxies can be bypassed).
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // Let the retired signup URL reach Next's 404 instead of redirecting to login.
  const publicHq = ["/hq/login", "/hq/signup", "/hq/signin", "/hq/profile", "/hq/welcome", "/hq/dashboard", "/hq/initialize", "/hq/join"];
  // Member pages use their own database-backed session and never hq_session.
  if (publicHq.includes(pathname) || /^\/hq\/team\/[^/]+$/.test(pathname)) return NextResponse.next();
  if (!request.cookies.get("hq_session")?.value) {
    return NextResponse.redirect(new URL("/hq/login", request.nextUrl));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/hq/:path*"],
};
