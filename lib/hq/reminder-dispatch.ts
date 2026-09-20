import "server-only";
import { type BuilderQuery } from "./builder-db";
import { listActiveCapabilities } from "./capabilities";
import { listAssignments } from "./captains";
import { periodColumns, reportingStatus, toPeriod } from "./reporting";
import { reminderMessage } from "./telegram-bot-view";

/**
 * What a reminder must still be true about at the moment it is handed to
 * Telegram, and the message rebuilt from those facts.
 *
 * This module exists because the checks `prepareReminder` makes are not the
 * checks that matter. A reminder is queued and sent through the shared
 * outgoing queue, and the gap between the two is ordinary rather than a race:
 * a deployment with no bot configured yet prepares reminders and delivers
 * nothing until the bot exists, a retryable send failure backs off for up to
 * half an hour, and the bot's own webhook drains the same queue on a
 * completely different schedule. An external review on 15 September 2026
 * reproduced six deliveries that were wrong by the time they left: a team
 * that had updated, a Captain who had been reassigned, one whose access had
 * been revoked, an archived edition, a closed week, and a message with
 * nothing left to say. The plan's wording is "recheck assignment and
 * reporting status IMMEDIATELY BEFORE SENDING", and before this that was not
 * where the recheck happened.
 *
 * It is a separate module from ./jobs so that `lib/hq/telegram-bot-store.ts`
 * can call it from inside the send path without a cycle: ./jobs imports the
 * store, so the store cannot import ./jobs. Nothing here imports the store.
 *
 * Putting the decision in the send path rather than in the job is the whole
 * point. A check the job makes protects only the job's own drain; a check
 * `deliverable()` makes protects every consumer of the queue there will ever
 * be, including the webhook and every retry.
 */

/** The `kind` a reminder row carries on the outgoing queue. The one string both sides compare. */
export const REMINDER_KIND = "reminder";

/**
 * Why a reminder was recorded but not delivered. Every one is shown to an
 * admin as it is; none of them ever becomes a project's weekly status,
 * because the weekly vocabulary is two words and this is not one of them.
 */
export type ReminderSkipReason =
  | "nothing_outstanding"
  | "no_assignments"
  | "capability_revoked"
  | "telegram_disconnected"
  | "messaging_disabled"
  | "no_chat"
  | "chat_not_bound"
  | "edition_archived"
  | "period_over"
  | "reminder_missing";

type OutstandingResult =
  | { ok: true; projectNames: string[]; editionName: string; period: { startDate: string; endDate: string } }
  | { ok: false; reason: ReminderSkipReason };

/**
 * The projects in an edition that are currently ACTIVE, by the same flag the
 * Captain leaderboard counts on (`hq_project_statuses.counts_as_active`).
 *
 * The plan stops reminders "on paused/inactive projects", and those are two
 * separate states in this data model: a reporting pause is an explicit
 * admin decision on `hq_reporting_eligibility`, and the status is the
 * project's health. Reading only the first meant an admin had to pause
 * reporting as well, purely to stop notifications, which is the same trap as
 * "archive the hackathon to stop the weekly prompts".
 *
 * `hq_projects.status_id` is NOT NULL, so this is an inner join and a project
 * always has an answer.
 */
async function activeProjectIds(db: BuilderQuery, projectIds: readonly string[]): Promise<Set<string>> {
  if (!projectIds.length) return new Set();
  const { rows } = await db.query(
    `SELECT p.id::text AS id FROM hq_projects p
     JOIN hq_project_statuses s ON s.id = p.status_id
     WHERE p.id = ANY($1::uuid[]) AND s.counts_as_active`,
    [[...projectIds]],
  );
  return new Set(rows.map((row) => String(row.id)));
}

/**
 * The teams a Captain still owes an update for in one reporting period, read
 * fresh, in the order the message lists them.
 *
 * Shared by `prepareReminder` and by the dispatch decision below so the two
 * cannot disagree about what "outstanding" means. Every gate the plan names
 * is here: the edition is not archived, the week is open, the account still
 * holds the Captain capability, the assignments are the current ones, the
 * projects are active and in reporting, and each named week is neither
 * exempt nor already complete.
 */
export async function outstandingForCaptain(
  db: BuilderQuery,
  input: { captainUserId: string; hackathonId: number; periodId: string; atMs: number },
): Promise<OutstandingResult> {
  const { rows: periodRows } = await db.query(
    `SELECT ${periodColumns("p")}, h.name AS edition_name, h.archived_at
     FROM hq_reporting_periods p JOIN hq_hackathons h ON h.id = p.hackathon_id
     WHERE p.id = $1::uuid AND p.hackathon_id = $2`,
    [input.periodId, input.hackathonId],
  );
  if (!periodRows.length) return { ok: false, reason: "reminder_missing" };
  const period = toPeriod(periodRows[0]);
  const editionName = String(periodRows[0].edition_name ?? "");
  if (periodRows[0].archived_at != null) return { ok: false, reason: "edition_archived" };
  // The week's exclusive end is the deadline the message names. Past it there
  // is nothing left to do about it, closed or not.
  if (period.closedAt || input.atMs >= Date.parse(period.endsAt)) return { ok: false, reason: "period_over" };

  if (!(await listActiveCapabilities(input.captainUserId, db)).includes("captain")) {
    return { ok: false, reason: "capability_revoked" };
  }

  const assignments = await listAssignments(db, { hackathonId: input.hackathonId, captainUserId: input.captainUserId });
  if (!assignments.length) return { ok: false, reason: "no_assignments" };

  const assignedIds = assignments.map((assignment) => assignment.projectId);
  const active = await activeProjectIds(db, assignedIds);
  const projectIds = assignedIds.filter((projectId) => active.has(projectId));
  if (!projectIds.length) return { ok: false, reason: "nothing_outstanding" };

  const statuses = await reportingStatus(db, { hackathonId: input.hackathonId, projectIds, atMs: input.atMs, includeHistory: true });
  const projectNames = statuses
    .filter((status) => {
      const week = status.history.find((candidate) => candidate.periodId === period.id);
      return week != null && !week.exempt && !week.completed && !status.paused;
    })
    .map((status) => status.projectName)
    .sort((a, b) => a.localeCompare(b));
  if (!projectNames.length) return { ok: false, reason: "nothing_outstanding" };
  // The period's own inclusive display dates, through `toPeriod`, so the
  // message prints the same week the screens do and no `date` column is
  // sliced as if it were UTC.
  return { ok: true, projectNames, editionName, period: { startDate: period.startDate, endDate: period.endDate } };
}

type ReminderDispatchDecision =
  | { ok: true; body: string; projectCount: number }
  | { ok: false; reason: ReminderSkipReason };

/**
 * The decision for one queued reminder, taken against the state that exists
 * NOW and written back to the reminder's own record.
 *
 * It rebuilds the body rather than approving the stored one, because a
 * message that names four teams when three have updated is wrong in exactly
 * the way a permission check cannot catch. The keyboard is reused untouched:
 * its callback reference is already bound to this account and chat, and
 * pressing it re-runs the bot's own gates.
 *
 * The write back is deliberate. The reminder record is what an admin reads,
 * and the drain that made this decision may be the webhook's rather than the
 * job's, which never reconciles anything. Recording here means the record is
 * right whichever consumer got there first.
 */
export async function reminderDispatchDecision(
  db: BuilderQuery,
  input: { outgoingId: string; atMs: number },
): Promise<ReminderDispatchDecision> {
  const { rows } = await db.query(
    `SELECT id::text AS id, captain_user_id, hackathon_id, period_id::text AS period_id
     FROM hq_reminder_deliveries WHERE outgoing_id = $1::uuid`,
    [input.outgoingId],
  );
  // A reminder row that is not there any more (a reset, a retention sweep, a
  // deleted edition) is not a licence to send a body nothing can vouch for.
  if (!rows.length) return { ok: false, reason: "reminder_missing" };
  const delivery = rows[0];
  const deliveryId = String(delivery.id);

  const outstanding = await outstandingForCaptain(db, {
    captainUserId: String(delivery.captain_user_id),
    hackathonId: Number(delivery.hackathon_id),
    periodId: String(delivery.period_id),
    atMs: input.atMs,
  });

  if (!outstanding.ok) {
    await db.query(
      `UPDATE hq_reminder_deliveries SET state = 'skipped', reason = $2, project_count = 0,
         resolved_at = COALESCE(resolved_at, now()), updated_at = now()
       WHERE id = $1::uuid AND state = 'queued'`,
      [deliveryId, outstanding.reason],
    );
    return { ok: false, reason: outstanding.reason };
  }

  const body = reminderMessage({
    editionName: outstanding.editionName,
    period: outstanding.period,
    projectNames: outstanding.projectNames,
  });
  await db.query(
    "UPDATE hq_reminder_deliveries SET project_count = $2, updated_at = now() WHERE id = $1::uuid AND state = 'queued'",
    [deliveryId, outstanding.projectNames.length],
  );
  return { ok: true, body, projectCount: outstanding.projectNames.length };
}
