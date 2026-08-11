import { isTrustedLumaSyncRequest } from "@/lib/hq/github-actions-auth";
import { syncLumaEvents } from "@/lib/hq/luma-sync";

export const dynamic = "force-dynamic";
// Vercel Hobby permits up to 60 seconds; normal syncs complete much sooner.
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!(await isTrustedLumaSyncRequest(request))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // Do not force a duplicate pull when an operator used the manual button in
  // the preceding five minutes. The database lock and timestamp guards inside
  // syncLumaEvents also make duplicate/overlapping invocations safe.
  const result = await syncLumaEvents();
  if (!result.ok) {
    console.error("Scheduled Luma sync failed", result.error);
    return Response.json(
      { ok: false, error: "Scheduled Luma sync failed" },
      { status: 502 },
    );
  }

  return Response.json(result);
}
