"use server";

import { z } from "zod";
import { requireUser } from "../auth";
import { builderDatabase } from "../builder-db";
import { requireHackathon } from "../hackathon";
import { listReminderDeliveries, reconcileReminderDeliveries, retryReminder, runDueWork, type JobRunSummary, type ReminderDeliveryView } from "../jobs";
import { isTelegramBotConfigured, telegramBotConfig, telegramSender } from "../telegram-bot-api";
import { flushBotMessages } from "../telegram-bot-store";
import { refreshHq } from "./util";

/**
 * The admin side of the scheduled reporting work: the authenticated manual
 * retry the plan asks for, beside the scheduled one.
 *
 * The scheduled runner is `.github/workflows/hq-jobs.yml` over
 * `/api/cron/hq-jobs`, authenticated by GitHub's OIDC identity with its own
 * audience. This is the same pass, triggered by an admin who is already
 * signed in, for the case where the scheduler is late, a Telegram outage has
 * cleared, or somebody simply wants to see the state now. It is the same
 * function, so it inherits every guard: closure is idempotent, a reminder is
 * recorded at most once per Captain, edition and week, and pressing the
 * button twice sends nothing twice.
 *
 * An explicit per-Captain resend is separate from the scheduled pass. It
 * retries an unsuccessful reminder after settings change, rechecking the
 * current recipient and teams without repeating successful deliveries.
 *
 * Operator gated, so this module must stay clear of the public member auth
 * graph (`tests/hq/operator-imports.test.ts`); `lib/hq/jobs.ts` reaches the
 * reporting service and the bot's store, neither of which reads a session.
 */

/**
 * The panel's own data after a manual run, so the list an admin is looking at
 * is the one the run just produced rather than the one the page loaded with.
 * The first read is `getReportingAdminData`; there is deliberately no second
 * action that only reads, because an exported Server Action nothing calls is
 * a live endpoint with no user (contracts.md, standing rule 1).
 */
type ReportingJobsView = {
  /** Whether this deployment has a Telegram bot at all. False means reminders are prepared and nothing is delivered. */
  botConfigured: boolean;
  deliveries: ReminderDeliveryView[];
};

export type RunJobsResult =
  | { ok: true; summary: JobRunSummary; view: ReportingJobsView }
  | { ok: false; error: string };

/** Runs one pass now. Same work, same guards and same idempotence as the scheduled run. */
export async function runReportingJobsNow(): Promise<RunJobsResult> {
  await requireUser();
  const hackathon = await requireHackathon();
  let summary: JobRunSummary;
  try {
    summary = await runDueWork();
  } catch (error) {
    console.error("Manual HQ reporting jobs run failed", error);
    // Honest about what a failure means. A pass is a sequence of separately
    // committed steps: weeks may already be closed, reminders already
    // recorded and messages already sent before it stopped. Every step is
    // idempotent, which is why running it again is safe, and that is a
    // different sentence from "nothing happened".
    return {
      ok: false,
      error: "The job stopped partway. Anything it already finished is recorded below, and running it again picks up from there without repeating itself.",
    };
  }
  const deliveries = await listReminderDeliveries(builderDatabase(), { hackathonId: hackathon.id });
  refreshHq("reporting");
  return { ok: true, summary, view: { botConfigured: isTelegramBotConfigured(), deliveries } };
}

/**
 * More of the reminder history than the panel loads with, for an edition
 * whose weeks have piled up. A read, like the page's own, gated the same way.
 */
export async function loadMoreReminderDeliveries(limit: number): Promise<{ ok: true; view: ReportingJobsView } | { ok: false; error: string }> {
  await requireUser();
  const hackathon = await requireHackathon();
  const deliveries = await listReminderDeliveries(builderDatabase(), { hackathonId: hackathon.id, limit });
  return { ok: true, view: { botConfigured: isTelegramBotConfigured(), deliveries } };
}

const resendSchema = z.object({ deliveryId: z.string().uuid(), expectedOutgoingId: z.string().uuid().nullable() });

/** Retries only the selected Captain's unsuccessful reminder in the selected edition. */
export async function resendCaptainReminder(input: z.infer<typeof resendSchema>): Promise<{ ok: true; delivery: ReminderDeliveryView } | { ok: false; error: string }> {
  await requireUser();
  const hackathon = await requireHackathon();
  const parsed = resendSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Unknown reminder. Reload and try again." };
  const config = telegramBotConfig();
  if (!config) return { ok: false, error: "The Telegram bot is not configured." };
  const db = builderDatabase();
  try {
    const result = await retryReminder(db, { ...parsed.data, hackathonId: hackathon.id });
    if (!result.ok) {
      const errors = {
        not_found: "This reminder is not available in the selected hackathon.",
        not_due: "This reminder's week is no longer open or due, or the hackathon is archived.",
        not_retryable: "This reminder is already sent, still retrying, or its delivery is uncertain. Reload to see its latest status.",
        changed: "This reminder has already been retried. Reload to see its latest status.",
        already_recorded: "This reminder has already been retried. Reload to see its latest status.",
      };
      return { ok: false, error: errors[result.reason] };
    }
    if (result.state === "queued") {
      await flushBotMessages(db, telegramSender(config), { outgoingId: result.outgoingId, limit: 1 });
      await reconcileReminderDeliveries(db);
    }
    const [delivery] = await listReminderDeliveries(db, { hackathonId: hackathon.id, deliveryId: parsed.data.deliveryId });
    refreshHq("reporting");
    if (!delivery) return { ok: false, error: "This reminder is no longer available. Reload to see the latest history." };
    return { ok: true, delivery };
  } catch (error) {
    console.error("Manual Captain reminder resend failed", error);
    return { ok: false, error: "The resend could not finish. Reload to check its delivery status before trying again." };
  }
}
