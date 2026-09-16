import "server-only";
import type { ColosseumFetch } from "@/lib/colosseum-api";
import type { Actor } from "./actor";
import { atomically, builderDatabase, type BuilderDatabase, type BuilderQuery } from "./builder-db";
import { HQ_JOBS_AUDIENCE } from "./github-actions-auth";
import { memberAuthOrigin } from "./member-auth-config";
import { CAPTAIN_PATH } from "./member-routes";
import { outstandingForCaptain, REMINDER_KIND, type ReminderSkipReason } from "./reminder-dispatch";
import {
  closePeriod,
  periodColumns,
  toDay,
  toIso,
  toPeriod,
  type ReportingPeriod,
} from "./reporting";
import {
  openSubmissionReconciliations,
  reconcileSubmissions,
  refreshDueSubmissions,
  type ReconcileSummary,
  type SubmissionRefreshSummary,
} from "./submission";
import { isTelegramBotConfigured, telegramBotConfig, telegramSender, type TelegramSender } from "./telegram-bot-api";
import {
  createBotAction,
  deliverableBotChat,
  enqueueBotMessage,
  flushBotMessages,
  purgeExpiredBotState,
  type FlushResult,
  type PurgeResult,
} from "./telegram-bot-store";
import { inlineKeyboard, openHqButton, reminderMessage, LABELS, type Keyboard } from "./telegram-bot-view";
import { activeTelegramIdentitySql } from "./telegram-identity-sql";

/**
 * The job runner (contracts.md's "Job runner" row): due Wednesday reminders,
 * period closure and the bounded retention sweep, all decided from database
 * periods and the campaign timezone rather than from a browser, a client
 * timer or one exact cron invocation.
 *
 * The shape follows from three sentences in the plan.
 *
 * 1. **"Do not rely on a Captain opening a page, a client timer or one exact
 *    cron invocation."** Nothing here is scheduled by a clock it keeps
 *    itself. `dueReminders` asks what the stored periods say is due AT AN
 *    INSTANT, and a period's `nudge_at` is a window (`nudge_at <= now <
 *    ends_at`), not a moment: a run that never happened on Wednesday at noon
 *    catches up on Wednesday at half past four, and a run that happens every
 *    fifteen minutes finds nothing due for the rest of the week. That is what
 *    "a missed job can catch up during the open period" means, and it is also
 *    why `hq_reminder_deliveries` exists: the catch-up is only safe because
 *    the decision is recorded exactly once.
 * 2. **"Recheck assignment and reporting status immediately before sending.
 *    If all projects have updated since the job was queued, cancel the
 *    message. It must not contain a reassigned project."** Nothing found in
 *    the scan is trusted by `prepareReminder`: it re-reads the capability,
 *    the assignments and `reportingStatus` inside the transaction that
 *    queues the message, and builds the body from that read alone. The scan
 *    only decides who is worth looking at.
 * 3. **"Treat a Telegram timeout with unknown delivery as uncertain rather
 *    than guaranteeing exactly-once delivery."** Delivery itself is phase
 *    7's, untouched: `enqueueBotMessage` writes the message inside this
 *    module's transaction, `flushBotMessages` claims it, re-validates the
 *    recipient and records what Telegram said, and this module only copies
 *    that answer onto the reminder row so an admin can read it.
 *
 * What this module never does: decide who may read what (every read goes
 * through the reporting service and the phase 1 decisions), write an update,
 * or put a note body, a note count or the word for a restricted audience into
 * a notification.
 *
 * It is imported by an operator Server Action (`lib/hq/actions/jobs.ts`), so
 * it must stay clear of the public member auth graph; `tests/hq/operator-imports.test.ts`
 * is the scan that holds it there.
 */

/** The one reminder type there is today. An open vocabulary on the row, pinned here, where the only writer reads it. */
export const REMINDER_TYPE_WEEKLY = "weekly_nudge";

/** How long a resolved reminder record is kept. Reporting outcomes and audit history are separate and are not swept. */
export const REMINDER_RETENTION_MS = 180 * 24 * 60 * 60_000;

/** How many queued messages one drain takes at a time. */
const FLUSH_BATCH = 25;
/** The hard ceiling on one pass, whatever the clock says. */
const MAX_FLUSH_BATCHES = 8;
/** Delivery shares the route's time with submission refresh and reconciliation. */
const SEND_BUDGET_MS = 20_000;
/** Reserve the route's last five seconds for recording results and responding. */
const JOB_BUDGET_MS = 55_000;

/** Re-exported so a caller reads the vocabulary from the module it imports. Defined beside the check that produces it. */
export type { ReminderSkipReason };
export { REMINDER_KIND };

/** A reminder the stored schedule says is due for one Captain in one edition. */
export type DueReminder = {
  captainUserId: string;
  hackathonId: number;
  reminderType: string;
  period: ReportingPeriod;
  /** The period's own nudge instant, which is what makes this due. */
  dueAt: string;
};

/**
 * Which reminders the stored periods say are due at `atMs`.
 *
 * The filter is the plan's own list, and each clause is here rather than in
 * `prepareReminder` because it is what makes the scan cheap: an open period
 * past its nudge instant, in an edition nobody archived, for a Captain who
 * currently holds at least one assigned project that is in reporting, was in
 * reporting before this week ended, and is not paused. "No qualifying update
 * yet" is deliberately NOT here: a Captain whose teams have all updated still
 * gets a recorded decision, because "we looked and there was nothing to send"
 * is exactly what an admin needs to see, and computing completion belongs to
 * the reporting service rather than to a join.
 *
 * A reminder already recorded for the same Captain, edition, period and type
 * is not offered again, so a pass every quarter of an hour finds nothing for
 * the rest of the week.
 */
export async function dueReminders(
  db: BuilderQuery,
  input: { atMs?: number; hackathonId?: number; reminderType?: string } = {},
): Promise<DueReminder[]> {
  const at = new Date(input.atMs ?? Date.now()).toISOString();
  const reminderType = input.reminderType ?? REMINDER_TYPE_WEEKLY;
  const values: unknown[] = [at, reminderType];
  let edition = "";
  if (input.hackathonId != null) {
    values.push(input.hackathonId);
    edition = ` AND p.hackathon_id = $${values.length}`;
  }
  const { rows } = await db.query(
    `SELECT DISTINCT a.captain_user_id AS captain_user_id, ${periodColumns("p")}
     FROM hq_reporting_periods p
     JOIN hq_hackathons h ON h.id = p.hackathon_id AND h.archived_at IS NULL
     JOIN hq_projects pr ON pr.hackathon_id = p.hackathon_id
     -- The project's own health, the same flag the Captain leaderboard counts
     -- on. The plan stops reminders "on paused/inactive projects", and those
     -- are two separate states here: the reporting pause below is an admin's
     -- explicit decision, this is whether the project is still a going
     -- concern. Reading only the pause meant an admin had to pause reporting
     -- purely to stop notifications for a team that was already marked
     -- inactive.
     JOIN hq_project_statuses st ON st.id = pr.status_id AND st.counts_as_active
     JOIN hq_captain_assignments a ON a.project_id = pr.id AND a.unassigned_at IS NULL AND a.captain_user_id IS NOT NULL
     JOIN hq_reporting_eligibility e ON e.project_id = pr.id AND e.paused_at IS NULL AND e.eligible_from < p.ends_at
     WHERE p.closed_at IS NULL AND p.nudge_at IS NOT NULL
       AND p.nudge_at <= $1::timestamptz AND $1::timestamptz < p.ends_at${edition}
       AND NOT EXISTS (
         SELECT 1 FROM hq_reminder_deliveries d
         WHERE d.captain_user_id = a.captain_user_id AND d.period_id = p.id AND d.reminder_type = $2
       )
     ORDER BY captain_user_id`,
    values,
  );
  return rows.map((row) => {
    const period = toPeriod(row);
    return { captainUserId: String(row.captain_user_id), hackathonId: period.hackathonId, reminderType, period, dueAt: period.nudgeAt ?? period.startsAt };
  });
}

export type PrepareReminderResult =
  | { ok: true; state: "queued"; deliveryId: string; projects: number }
  | { ok: true; state: "skipped"; deliveryId: string; reason: ReminderSkipReason }
  | { ok: false; reason: "already_recorded" | "not_due" };

/** Why a Captain cannot be messaged right now, told apart so the record says which of the three it was. */
async function botReachFailure(tx: BuilderQuery, userId: string): Promise<ReminderSkipReason> {
  const { rows } = await tx.query(
    `SELECT c.messaging_enabled, c.chat_id, c.chat_bound_telegram_user_id::text AS bound_to,
            i.user_id IS NOT NULL AS has_identity, i.telegram_user_id::text AS telegram_user_id
     FROM hq_builder_profiles b
     LEFT JOIN hq_telegram_bot_consent c ON c.user_id = b.id
     LEFT JOIN hq_auth_telegram_identity i ON i.user_id = b.id AND ${activeTelegramIdentitySql()}
     WHERE b.id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row || !row.has_identity) return "telegram_disconnected";
  if (!row.messaging_enabled) return "messaging_disabled";
  // A consent row written from /hq/account before the person ever messaged
  // the bot has nowhere to deliver to at all.
  if (row.chat_id == null) return "no_chat";
  // There is a chat, but the account connected now is not the one that opened
  // it. A different Telegram account's private chat is not a destination this
  // account can be reached at, whatever the consent row says.
  return String(row.bound_to ?? "") === String(row.telegram_user_id ?? "") ? "no_chat" : "chat_not_bound";
}

/**
 * Builds and queues one Captain's reminder for one reporting period, or
 * records why it was not sent. The whole thing is ONE transaction, which is
 * what makes every claim below true at the same instant.
 *
 * The first statement is the duplicate guard, and it is a real one rather
 * than a check followed by a write: the insert is `ON CONFLICT DO NOTHING
 * RETURNING`, so two passes running over each other both attempt it, the
 * second blocks on the unique index until the first commits, and then finds
 * no row to return. Nothing after that point runs twice, message included.
 *
 * Everything the scan found is then read again, because the plan requires it
 * and because the gap between the two is exactly where a reassignment, a
 * revoked capability, a withdrawn consent or an update that has just arrived
 * lives:
 *
 * - the Captain capability, because a revocation clears assignments and must
 *   not leave a message describing teams behind it;
 * - the current assignments, so a project that moved to another Captain
 *   cannot appear in this message;
 * - `reportingStatus` for exactly those projects, so a team that updated an
 *   hour ago is not named, and a Captain with nothing outstanding gets no
 *   message at all;
 * - the chat, the consent and the Telegram identity, so an unreachable
 *   Captain is a recorded skip rather than a queued message nobody can
 *   receive.
 */
export async function prepareReminder(
  db: BuilderDatabase | BuilderQuery,
  input: {
    captainUserId: string;
    hackathonId: number;
    periodId: string;
    reminderType?: string;
    atMs?: number;
    hqOrigin?: string | null;
  },
): Promise<PrepareReminderResult> {
  const atMs = input.atMs ?? Date.now();
  const reminderType = input.reminderType ?? REMINDER_TYPE_WEEKLY;
  const hqOrigin = input.hqOrigin !== undefined ? input.hqOrigin : memberAuthOrigin();
  return atomically(db, async (tx) => {
    const { rows: periodRows } = await tx.query(
      `SELECT ${periodColumns("p")}, (SELECT name FROM hq_hackathons h WHERE h.id = p.hackathon_id) AS edition_name,
              (SELECT archived_at FROM hq_hackathons h WHERE h.id = p.hackathon_id) AS archived_at
       FROM hq_reporting_periods p WHERE p.id = $1::uuid AND p.hackathon_id = $2`,
      [input.periodId, input.hackathonId],
    );
    if (!periodRows.length) return { ok: false, reason: "not_due" } as const;
    const period = toPeriod(periodRows[0]);
    const editionName = String(periodRows[0].edition_name ?? "");
    // A week that is not open at this instant, one that is already closed and
    // an archived edition are all "there is nothing to remind anyone about",
    // and none of them writes a record: the reminder was never due.
    const open = period.nudgeAt != null && Date.parse(period.nudgeAt) <= atMs && atMs < Date.parse(period.endsAt);
    if (!open || period.closedAt || periodRows[0].archived_at != null) return { ok: false, reason: "not_due" } as const;

    // `created_at` is written from the JOB'S clock, not the database's. It is
    // the left-hand side of the staleness comparison in
    // the retention sweep, whose right-hand side is the job's clock too, so
    // writing `now()` here would compare two different readings and make the
    // answer depend on how far apart the application server and the database
    // happen to be.
    const { rows: claimed } = await tx.query(
      `INSERT INTO hq_reminder_deliveries (captain_user_id, hackathon_id, period_id, reminder_type, due_at, state, created_at, updated_at)
       VALUES ($1, $2, $3::uuid, $4, $5::timestamptz, 'queued', $6::timestamptz, $6::timestamptz)
       ON CONFLICT (captain_user_id, hackathon_id, period_id, reminder_type) DO NOTHING
       RETURNING id::text AS id`,
      [input.captainUserId, input.hackathonId, period.id, reminderType, period.nudgeAt ?? period.startsAt, new Date(atMs).toISOString()],
    );
    if (!claimed.length) return { ok: false, reason: "already_recorded" } as const;
    const deliveryId = String(claimed[0].id);

    const skip = async (reason: ReminderSkipReason): Promise<PrepareReminderResult> => {
      await tx.query(
        "UPDATE hq_reminder_deliveries SET state='skipped', reason=$2, project_count=0, resolved_at=$3::timestamptz, updated_at=$3::timestamptz WHERE id=$1::uuid",
        [deliveryId, reason, new Date(atMs).toISOString()],
      );
      return { ok: true, state: "skipped", deliveryId, reason };
    };

    // The same computation the send path runs again immediately before every
    // attempt, from ./reminder-dispatch, so preparing and dispatching cannot
    // disagree about what "outstanding" means.
    const outstanding = await outstandingForCaptain(tx, {
      captainUserId: input.captainUserId,
      hackathonId: input.hackathonId,
      periodId: period.id,
      atMs,
    });
    if (!outstanding.ok) return skip(outstanding.reason);

    const chat = await deliverableBotChat(tx, input.captainUserId);
    if (!chat) return skip(await botReachFailure(tx, input.captainUserId));

    // One callback button that re-enters the bot's own compose list, and the
    // HQ link beside it: the plan's "links/actions to update in the bot or
    // HQ". The button is an opaque reference bound to this account and chat
    // like every other one, so pressing it runs the bot's three gates again
    // rather than trusting the message it came from.
    // Bound to the edition this reminder is about, so a Captain working two
    // hackathons is not silently shown the default edition's teams when they
    // press it.
    const action = await createBotAction(
      tx,
      { userId: input.captainUserId, chatId: chat.chatId, kind: "compose.page", page: 0, hackathonId: input.hackathonId, expiresAt: period.endsAt },
      atMs,
    );
    const keyboard: Keyboard = [
      [{ text: LABELS.addUpdate, callbackId: action.id }],
      openHqButton(hqOrigin ? `${hqOrigin}${CAPTAIN_PATH}` : null),
    ].filter((row) => row.length);

    const body = reminderMessage({ editionName, period, projectNames: outstanding.projectNames });
    const outgoingId = await enqueueBotMessage(tx, {
      chatId: chat.chatId,
      userId: input.captainUserId,
      kind: REMINDER_KIND,
      body,
      replyMarkup: inlineKeyboard(keyboard),
      // Captain, edition, period and type: the plan's reminder key, and the
      // same string the delivery row is unique on, so the queue and the
      // record cannot disagree about what one reminder is.
      dedupeKey: `reminder:${reminderType}:${input.captainUserId}:${input.hackathonId}:${period.id}`,
      // Deliberately no project id. A reminder is about several projects, so
      // the single-project re-check in `flushBotMessages` has nothing to
      // check; `deliverable()` recognises the reminder kind and re-decides
      // the whole message through ./reminder-dispatch instead, which is the
      // check that runs for every consumer of the queue.
      projectId: null,
      hackathonId: input.hackathonId,
    });
    await tx.query(
      "UPDATE hq_reminder_deliveries SET outgoing_id=$2::uuid, project_count=$3, updated_at=now() WHERE id=$1::uuid",
      [deliveryId, outgoingId, outstanding.projectNames.length],
    );
    return { ok: true, state: "queued", deliveryId, projects: outstanding.projectNames.length };
  });
}

/**
 * Resolves a queued reminder whose week is over, without waiting for somebody
 * to try to send it.
 *
 * This is NOT the correctness check. `deliverable()` re-decides and rebuilds
 * every reminder immediately before every attempt, so a message whose week
 * has ended is refused there whichever consumer of the queue reaches it. What
 * this adds is the answer for a reminder nobody tries to send at all: a
 * deployment with no bot configured never drains the queue, and a row sitting
 * at "waiting to send" for a week that ended is a worse thing for an admin to
 * read than "not sent, the week ended".
 *
 * There used to be a time-to-live here as well. It is gone on purpose: now
 * that the body is rebuilt at dispatch, age no longer makes a reminder wrong,
 * and dropping a three-hour-old one would discard a message that is still
 * accurate and still wanted.
 */
export async function expireEndedReminders(db: BuilderQuery, atMs: number = Date.now()): Promise<number> {
  const { rows } = await db.query(
    `UPDATE hq_telegram_outgoing o
       SET state='skipped', skip_reason='period_over', claimed_by=NULL, claim_expires_at=NULL
     FROM hq_reminder_deliveries d
     JOIN hq_reporting_periods p ON p.id = d.period_id
     WHERE o.id = d.outgoing_id AND o.state = 'queued' AND d.state = 'queued'
       AND (p.ends_at <= $1::timestamptz OR p.closed_at IS NOT NULL)
       AND (o.claim_expires_at IS NULL OR o.claim_expires_at <= $1::timestamptz)
     RETURNING o.id::text AS id`,
    [new Date(atMs).toISOString()],
  );
  return rows.length;
}

/**
 * Copies what happened to the queued message onto the reminder record.
 *
 * The delivery rules stay entirely in ./telegram-bot-store: this is one
 * statement that reads the answer, so there is no second retry policy, no
 * second idea of what "sent" means, and nothing to keep in step. It only
 * touches reminders still recorded `queued`, so a resolved record is never
 * rewritten by a later pass.
 */
export async function reconcileReminderDeliveries(db: BuilderQuery): Promise<number> {
  const { rows } = await db.query(
    `UPDATE hq_reminder_deliveries d SET
       state = CASE o.state WHEN 'sent' THEN 'sent' WHEN 'failed' THEN 'failed' WHEN 'skipped' THEN 'skipped' ELSE d.state END,
       reason = COALESCE(o.skip_reason, d.reason),
       provider_message_id = o.provider_message_id,
       attempts = o.attempts,
       last_error = o.last_error,
       next_attempt_at = o.next_attempt_at,
       resolved_at = CASE WHEN o.state <> 'queued' THEN now() ELSE d.resolved_at END,
       updated_at = now()
     FROM hq_telegram_outgoing o
     WHERE o.id = d.outgoing_id AND d.state = 'queued'
       -- A message still queued is copied too, not only a finished one. This
       -- clause used to require a finished outgoing row, so a reminder that
       -- Telegram had rate limited twice read back to an admin as untouched:
       -- zero attempts, no reason, nothing to distinguish it from one nobody
       -- had tried yet.
       AND (o.state <> 'queued'
            OR d.attempts IS DISTINCT FROM o.attempts
            OR d.last_error IS DISTINCT FROM o.last_error
            OR d.next_attempt_at IS DISTINCT FROM o.next_attempt_at)
     RETURNING d.id::text AS id`,
  );
  return rows.length;
}

/** Removes resolved reminder records past their retention, and only for weeks that are closed. */
export async function purgeReminderDeliveries(db: BuilderQuery, atMs: number = Date.now()): Promise<number> {
  const { rows } = await db.query(
    `DELETE FROM hq_reminder_deliveries d
     USING hq_reporting_periods p
     WHERE p.id = d.period_id AND p.closed_at IS NOT NULL AND d.state <> 'queued' AND d.created_at <= $1::timestamptz
     RETURNING d.id::text AS id`,
    [new Date(atMs - REMINDER_RETENTION_MS).toISOString()],
  );
  return rows.length;
}

export type ClosedPeriod = {
  periodId: string;
  hackathonId: number;
  sequence: number;
  completed: number;
  missed: number;
};

/**
 * Closes every reporting period whose exclusive end has passed and which is
 * not closed yet, oldest first.
 *
 * `closePeriod` already does the work and is already idempotent, so this is
 * only the "which ones" half. Archived editions are included on purpose:
 * archiving stops reminders, but a week that ended is history either way and
 * recording it late is the plan's "failure to update is recorded
 * historically", not a notification.
 */
export async function closeDuePeriods(
  db: BuilderDatabase | BuilderQuery,
  input: { atMs?: number; hackathonId?: number; deadlineMs?: number } = {},
): Promise<{ closed: ClosedPeriod[]; reconciliationsOpened: number }> {
  const atMs = input.atMs ?? Date.now();
  const values: unknown[] = [new Date(atMs).toISOString()];
  let edition = "";
  if (input.hackathonId != null) {
    values.push(input.hackathonId);
    edition = ` AND p.hackathon_id = $${values.length}`;
  }
  const { rows } = await db.query(
    `SELECT ${periodColumns("p")} FROM hq_reporting_periods p
     WHERE p.closed_at IS NULL AND p.ends_at <= $1::timestamptz${edition}
     ORDER BY p.hackathon_id, p.sequence`,
    values,
  );
  const actor: Actor = { kind: "job", audience: HQ_JOBS_AUDIENCE };
  const closed: ClosedPeriod[] = [];
  for (const row of rows) {
    if (input.deadlineMs != null && Date.now() >= input.deadlineMs) break;
    const period = toPeriod(row);
    const result = await closePeriod(db, { periodId: period.id, actor, atMs });
    // `alreadyClosed` means another pass got there first; its outcomes are
    // already recorded and reporting it again would double the count an
    // operator reads.
    if (!result.ok || result.alreadyClosed) continue;
    closed.push({ periodId: period.id, hackathonId: period.hackathonId, sequence: period.sequence, completed: result.completed, missed: result.missed });
  }
  // Phase 10: every closed SUBMISSION period owes one reconciliation per
  // accountable imported project, so that evidence arriving later has
  // somewhere to land. Deliberately AFTER the loop and over the stored
  // outcomes rather than inside it: closing and opening are separate
  // statements, and a pass that died between them would otherwise leave a
  // closed final period with nothing tracking its unverified submissions
  // forever. Written as a catch-up, it repairs itself on the next pass.
  const reconciliationsOpened = await openSubmissionReconciliations(db, {
    ...(input.hackathonId != null ? { hackathonId: input.hackathonId } : {}),
  });
  return { closed, reconciliationsOpened };
}

/** One reminder as an admin reads it. Names, counts and outcomes; never a project id and never any update text. */
export type ReminderDeliveryView = {
  id: string;
  captainUserId: string;
  captainName: string;
  hackathonId: number;
  periodId: string;
  periodSequence: number;
  periodStartDate: string;
  periodEndDate: string;
  reminderType: string;
  dueAt: string;
  state: "queued" | "sent" | "skipped" | "failed";
  reason: string | null;
  projectCount: number;
  providerMessageId: string | null;
  attempts: number;
  /** Telegram's own code and words about a failure, kept for an operator. Never rendered into a chat. */
  lastError: string | null;
  /** When the queue will try again, or null when it is not waiting on one. */
  nextAttemptAt: string | null;
  /**
   * The last attempt ended without an answer: a timeout or a network failure,
   * where Telegram may or may not have accepted the message.
   *
   * Kept separate from `state` on purpose and preserved through exhaustion.
   * "Could not be sent" is a claim, and it is the wrong claim for a message
   * that may well have arrived; an admin deciding whether to chase a Captain
   * needs to know which of the two they are looking at.
   */
  deliveryUncertain: boolean;
  createdAt: string;
  resolvedAt: string | null;
};

/** Transport codes that mean "we do not know", from `lib/hq/telegram-bot-api.ts`. */
const UNCERTAIN_CODES = new Set(["timeout", "network"]);

/** Whether the recorded failure was an unanswered one. `last_error` is written as "<code>: <detail>", or just "<code>". */
const isUncertain = (lastError: unknown): boolean =>
  lastError != null && UNCERTAIN_CODES.has(String(lastError).split(":")[0].trim());

const toDeliveryView = (row: Record<string, unknown>): ReminderDeliveryView => ({
  id: String(row.id),
  captainUserId: String(row.captain_user_id),
  captainName: String(row.captain_name ?? row.captain_user_id),
  hackathonId: Number(row.hackathon_id),
  periodId: String(row.period_id),
  periodSequence: Number(row.sequence),
  // Through the reporting service's own `toDay`, because the driver hands a
  // `date` column back as a Date at LOCAL midnight and the UTC slice would be
  // the day before in a negative offset.
  periodStartDate: toDay(row.start_date),
  periodEndDate: toDay(row.end_date),
  reminderType: String(row.reminder_type),
  dueAt: toIso(row.due_at),
  state: row.state === "sent" || row.state === "skipped" || row.state === "failed" ? row.state : "queued",
  reason: row.reason == null ? null : String(row.reason),
  projectCount: Number(row.project_count),
  providerMessageId: row.provider_message_id == null ? null : String(row.provider_message_id),
  attempts: Number(row.attempts),
  lastError: row.last_error == null ? null : String(row.last_error),
  nextAttemptAt: row.next_attempt_at == null ? null : toIso(row.next_attempt_at),
  deliveryUncertain: isUncertain(row.last_error),
  createdAt: toIso(row.created_at),
  resolvedAt: row.resolved_at == null ? null : toIso(row.resolved_at),
});

/** The edition's reminder history, newest first. Operator gated by its caller; this is a read, not a decision. */
export async function listReminderDeliveries(
  db: BuilderQuery,
  input: { hackathonId: number; limit?: number },
): Promise<ReminderDeliveryView[]> {
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
  const { rows } = await db.query(
    `SELECT d.id::text AS id, d.captain_user_id, b.name AS captain_name, d.hackathon_id, d.period_id::text AS period_id,
            p.sequence, p.start_date, p.end_date, d.reminder_type, d.due_at, d.state, d.reason, d.project_count,
            d.provider_message_id, d.attempts, d.last_error, d.next_attempt_at, d.created_at, d.resolved_at
     FROM hq_reminder_deliveries d
     JOIN hq_reporting_periods p ON p.id = d.period_id
     LEFT JOIN hq_builder_profiles b ON b.id = d.captain_user_id
     WHERE d.hackathon_id = $1
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT $2`,
    [input.hackathonId, limit],
  );
  return rows.map(toDeliveryView);
}

export type JobRunSummary = {
  at: string;
  closures: { closed: number; periods: ClosedPeriod[] };
  reminders: { due: number; queued: number; skipped: number; alreadyRecorded: number; expired: number; reconciled: number };
  /**
   * Null when this deployment has no Telegram bot configured; the messages
   * stay queued for a pass that does. `stoppedOnBudget` means the pass ran
   * out of its sending budget with work left, which the next pass picks up.
   */
  delivery: FlushResult | null;
  /**
   * Phase 10's final-period work: the bounded staleness refresh (null unless
   * an admin configured an interval and a submission period is open) and the
   * closing reconciliation. Both talk to Colosseum, so both are bounded by a
   * batch AND by a time budget, and both are safe to run at any frequency.
   */
  submissions: { refreshed: SubmissionRefreshSummary; reconciled: ReconcileSummary; reconciliationsOpened: number };
  purged: PurgeResult & { reminders: number };
};

/**
 * One pass of the due work: close the weeks that ended, decide this week's
 * reminders, drop the stale ones, drain the queue, record what Telegram said
 * and sweep expired state.
 *
 * Safe to run at any frequency and safe to run twice at once. Closure is
 * idempotent, a reminder is recorded at most once per Captain, edition,
 * period and type, and the queue is claimed before it is sent. Running it
 * more often makes reminders punctual; running it rarely makes them late but
 * never wrong, which is the trade the plan asks for in "do not rely on ... one
 * exact cron invocation".
 *
 * Closure runs first so that a week which has just ended is closed before the
 * reminder scan looks at it, which is the cheapest way to be sure no reminder
 * is built for a period that is already history.
 */
export async function runDueWork(
  options: {
    db?: BuilderDatabase;
    /** The transport, or null to prepare everything and deliver nothing. Omit to build one from the environment. */
    sender?: TelegramSender | null;
    now?: number;
    hqOrigin?: string | null;
    hackathonId?: number;
    /** The Colosseum transport for phase 10's submission work. Omit to use the runtime's own `fetch`. */
    colosseumFetch?: ColosseumFetch;
  } = {},
): Promise<JobRunSummary> {
  const deadlineMs = Date.now() + JOB_BUDGET_MS;
  const db = options.db ?? builderDatabase();
  const now = options.now ?? Date.now();
  const hqOrigin = options.hqOrigin !== undefined ? options.hqOrigin : memberAuthOrigin();

  const closures = await closeDuePeriods(db, { atMs: now, deadlineMs, ...(options.hackathonId != null ? { hackathonId: options.hackathonId } : {}) });

  const due = await dueReminders(db, { atMs: now, ...(options.hackathonId != null ? { hackathonId: options.hackathonId } : {}) });
  let queued = 0;
  let skipped = 0;
  let alreadyRecorded = 0;
  for (const reminder of due) {
    if (Date.now() >= deadlineMs) break;
    const result = await prepareReminder(db, {
      captainUserId: reminder.captainUserId,
      hackathonId: reminder.hackathonId,
      periodId: reminder.period.id,
      reminderType: reminder.reminderType,
      atMs: now,
      hqOrigin,
    });
    if (!result.ok) alreadyRecorded += 1;
    else if (result.state === "queued") queued += 1;
    else skipped += 1;
  }

  const expired = await expireEndedReminders(db, now);

  let delivery: FlushResult | null = null;
  const sender = options.sender !== undefined ? options.sender : isTelegramBotConfigured() ? telegramSender(telegramBotConfig()!) : null;
  if (sender) {
    delivery = { sent: 0, failed: 0, retrying: 0, skipped: 0 };
    // The wall clock, not the injected `now`: the budget is about how long
    // this invocation has actually been running, which a fixed test instant
    // says nothing about.
    const sendDeadlineMs = Math.min(deadlineMs, Date.now() + SEND_BUDGET_MS);
    for (let batch = 0; batch < MAX_FLUSH_BATCHES; batch += 1) {
      const result = await flushBotMessages(db, sender, {
        limit: FLUSH_BATCH,
        deadlineMs: sendDeadlineMs,
        // Only forward a caller-supplied instant. Left to itself,
        // `flushBotMessages` reads the clock per message, which is what makes
        // the dispatch check current rather than as old as this pass.
        ...(options.now != null ? { now: options.now } : {}),
      });
      delivery.sent += result.sent;
      delivery.failed += result.failed;
      delivery.retrying += result.retrying;
      delivery.skipped += result.skipped;
      if (result.stoppedOnBudget) {
        delivery.stoppedOnBudget = true;
        break;
      }
      if (result.sent + result.failed + result.retrying + result.skipped < FLUSH_BATCH) break;
    }
  }

  // The final period, after the reminders: a stale snapshot refreshed now is
  // read by the next pass's closure, and a reconciliation opened by this
  // pass's closure is attempted from here on the pass after it. Both are
  // no-ops on an edition with no submission period open and no pending row.
  const refreshed = await refreshDueSubmissions(db, {
    atMs: now,
    deadlineMs,
    ...(options.hackathonId != null ? { hackathonId: options.hackathonId } : {}),
    ...(options.colosseumFetch ? { fetcher: options.colosseumFetch } : {}),
  });
  const reconciledSubmissions = await reconcileSubmissions(db, {
    atMs: now,
    deadlineMs,
    ...(options.hackathonId != null ? { hackathonId: options.hackathonId } : {}),
    ...(options.colosseumFetch ? { fetcher: options.colosseumFetch } : {}),
  });

  const reconciled = await reconcileReminderDeliveries(db);
  const purged = await purgeExpiredBotState(db, now);
  const purgedReminders = await purgeReminderDeliveries(db, now);

  return {
    at: new Date(now).toISOString(),
    closures: { closed: closures.closed.length, periods: closures.closed },
    reminders: { due: due.length, queued, skipped, alreadyRecorded, expired, reconciled },
    delivery,
    submissions: { refreshed, reconciled: reconciledSubmissions, reconciliationsOpened: closures.reconciliationsOpened },
    purged: { ...purged, reminders: purgedReminders },
  };
}
