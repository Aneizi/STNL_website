import { isTrustedHqJobsRequest } from "@/lib/hq/github-actions-auth";
import { runDueWork } from "@/lib/hq/jobs";

/**
 * The HQ reporting jobs endpoint: due Wednesday reminders, period closure and
 * the retention sweep.
 *
 * Its own audience and its own workflow file, checked by
 * `isTrustedHqJobsRequest`, so the Luma sync's identity cannot call this and
 * this job's identity cannot call the Luma sync. There is no shared secret to
 * store or rotate: GitHub's OIDC token is minted per run and verified against
 * GitHub's JWKS.
 *
 * Deliberately thin. Every decision, every duplicate guard and every retry
 * rule lives in `lib/hq/jobs.ts` so that it can be tested without a server, a
 * bot or a scheduler; this file is the address the workflow posts to.
 *
 * Safe to call at any frequency and safe to call twice at once: closure is
 * idempotent, a reminder is recorded at most once per Captain, edition,
 * period and type, and the outgoing queue is claimed before it is sent. That
 * is what lets the workflow run on a short interval rather than depending on
 * one exact invocation landing at noon.
 */
export const dynamic = "force-dynamic";
// Vercel Hobby permits up to 60 seconds. A pass closes a handful of weeks and
// sends a handful of messages; anything left queued is picked up by the next
// run rather than held for one long invocation.
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!(await isTrustedHqJobsRequest(request))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runDueWork();
    // Counts and period ids only. No Captain, no chat, no project name and no
    // update text ever reaches a workflow log.
    return Response.json({
      ok: true,
      at: summary.at,
      closed: summary.closures.closed,
      reminders: summary.reminders,
      delivery: summary.delivery,
      submissions: summary.submissions,
      purged: summary.purged,
    });
  } catch (error) {
    console.error("HQ reporting jobs failed", error);
    return Response.json({ ok: false, error: "HQ reporting jobs failed" }, { status: 502 });
  }
}
