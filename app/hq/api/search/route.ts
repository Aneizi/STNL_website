import { NextResponse, type NextRequest } from "next/server";
import { currentUser } from "@/lib/hq/auth";
import { searchAll } from "@/lib/hq/queries";

export const dynamic = "force-dynamic";

// GET keeps ⌘K search off the server-action queue (actions dispatch
// sequentially) and lets the client abort stale keystrokes.
export async function GET(request: NextRequest) {
  const user = await currentUser();
  if (!user || user.mustChangePassword) {
    return NextResponse.json({ results: [] }, { status: 401 });
  }
  const q = request.nextUrl.searchParams.get("q") ?? "";
  if (q.length > 100) return NextResponse.json({ results: [] });
  const results = await searchAll(q);
  return NextResponse.json({ results });
}
