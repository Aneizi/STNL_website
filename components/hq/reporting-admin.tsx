"use client";

import { useState, useTransition } from "react";
import { showToast } from "@/components/hq/toast";
import { runReportingJobsNow, type RunJobsResult } from "@/lib/hq/actions/jobs";
import {
  applyReportingSchedule,
  saveReportingConfiguration,
  type ReportingScheduleView,
} from "@/lib/hq/actions/reporting-admin";
import type { ReportingAdminData } from "@/lib/hq/builder-admin-queries";
import type { ReportingPeriodConflict, ReportingScheduleProblem } from "@/lib/hq/reporting";
import { utcToZonedDateTime } from "@/lib/hq/reporting-periods";
import type { ReminderDeliveryView } from "@/lib/hq/jobs";
import { periodRangeLabel } from "@/lib/hq/reporting-view";
import styles from "./builder-admin.module.css";

/**
 * Admin's weekly reporting panel: the schedule, what a date change would do
 * to it, and the settings that are not the edition's own dates.
 *
 * The reporting window is `hq_hackathons.start_date`/`end_date` and the
 * timezone is `hq_settings.timezone`, both edited above in this same page.
 * Nothing here copies either: that would be the competing source of truth
 * the data contract forbids. What this panel adds is the step between
 * changing those dates and the stored weeks changing, which the plan
 * requires: `previewReportingPeriods` says what applying them would add,
 * move or remove, and names every week it must not touch because people
 * have already reported against it. Applying is a separate, explicit press.
 */

const WEEKDAYS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 7, label: "Sunday" },
];

/**
 * What each recorded reminder outcome means, in a sentence rather than a
 * code. Every one of these is about the MESSAGE, never about the week: a
 * Captain nobody could reach does not make a team's week anything other than
 * Updated or Not updated, which is the plan's "visible to admins without
 * becoming new weekly project statuses".
 */
const REMINDER_STATES: Record<ReminderDeliveryView["state"], string> = {
  queued: "Waiting to send",
  sent: "Sent",
  skipped: "Not sent",
  failed: "Could not be sent",
};

const REMINDER_REASONS: Record<string, string> = {
  nothing_outstanding: "every assigned team had already updated, so there was nothing to send",
  no_assignments: "the Captain had no assigned teams by then",
  capability_revoked: "Captain access had been removed",
  telegram_disconnected: "the Captain has not connected Telegram",
  messaging_disabled: "the Captain has bot messages turned off",
  no_chat: "the Captain has never opened a chat with the bot",
  chat_changed: "the Captain moved to a new chat with the bot",
  not_authorized: "the Captain no longer holds the team it named",
  period_over: "the week ended before Telegram accepted it",
  too_old: "it waited too long to still be accurate",
  message_too_long: "the message was too long for Telegram",
};

/** The reason line, which falls back to Telegram's own code rather than swallowing something we have no sentence for. */
function reminderReason(reminder: ReminderDeliveryView): string {
  if (!reminder.reason) return "";
  return REMINDER_REASONS[reminder.reason] ?? `Telegram refused it (${reminder.reason})`;
}

const CONFLICT_REASONS: Record<ReportingPeriodConflict["reason"], string> = {
  has_entries: "teams have already written updates in it",
  has_outcomes: "its result is already recorded",
  closed: "it is closed",
};

/** What applying the current dates would do, in a sentence rather than three counts. */
function planSummary(plan: ReportingAdminData["plan"]): string {
  const parts: string[] = [];
  if (plan.added) parts.push(`add ${plan.added} week${plan.added === 1 ? "" : "s"}`);
  if (plan.updated) parts.push(`move ${plan.updated} week${plan.updated === 1 ? "" : "s"}`);
  if (plan.removed) parts.push(`remove ${plan.removed} week${plan.removed === 1 ? "" : "s"}`);
  if (!parts.length) return "The stored weeks already match the hackathon dates. Applying would change nothing.";
  const change = `Applying the hackathon dates would ${parts.join(", ")}.`;
  return plan.blocked ? `${change} It is refused, because of what it would leave behind.` : change;
}

/**
 * Why a change is refused, in days rather than in the word "discontinuous".
 * A week that already holds updates keeps its own dates whatever the hackathon
 * dates say, and the weeks around it do not, so the two can end up leaving a
 * day in no week at all or a day in two.
 */
function problemLine(problem: ReportingScheduleProblem): string {
  if (problem.kind === "overlap") {
    return `Week ${problem.sequence} would still run to ${problem.beforeEndDate}, and the week after it would already have started on ${problem.afterStartDate}. Those days would belong to two weeks at once.`;
  }
  if (problem.kind === "gap") {
    return `Week ${problem.sequence} would end on ${problem.beforeEndDate} and the next week would not start until ${problem.afterStartDate}. The days in between would belong to no week, so an update written on one of them would have nowhere to go.`;
  }
  return "The weeks would no longer be numbered one after another.";
}

export function ReportingAdmin({ data }: { data: ReportingAdminData }) {
  const [plan, setPlan] = useState(data.plan);
  const timezone = data.schedule?.timezone ?? "Europe/Amsterdam";
  const [applying, startApply] = useTransition();
  const [saving, startSave] = useTransition();
  const [saved, setSaved] = useState("");
  const [reminders, setReminders] = useState(data.reminders);
  const [running, startRun] = useTransition();
  const [ranSummary, setRanSummary] = useState("");

  const runJobs = () =>
    startRun(async () => {
      setRanSummary("");
      const result: RunJobsResult = await runReportingJobsNow();
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      setReminders(result.view.deliveries);
      const { closures, reminders: counts, delivery } = result.summary;
      const parts = [
        `${counts.due} reminder${counts.due === 1 ? "" : "s"} were due`,
        `${counts.queued} prepared`,
        `${counts.skipped} not sent`,
        `${closures.closed} week${closures.closed === 1 ? "" : "s"} closed`,
      ];
      if (delivery) parts.push(`${delivery.sent} delivered`);
      setRanSummary(`${parts.join(", ")}.`);
    });

  const apply = () =>
    startApply(async () => {
      const result: { ok: true; schedule: ReportingScheduleView } | { ok: false; error: string } = await applyReportingSchedule();
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      setPlan(result.schedule.plan);
      if (result.schedule.plan.blocked) {
        showToast("Nothing was changed. These dates would leave a gap or an overlap between the weeks; see below.");
        return;
      }
      showToast(
        result.schedule.plan.conflicts.length
          ? `Applied. ${result.schedule.plan.conflicts.length} week${result.schedule.plan.conflicts.length === 1 ? " was" : "s were"} left exactly as recorded.`
          : "Applied.",
      );
    });

  return (
    <section className={styles.section} aria-labelledby="reporting-admin-title">
      <h2 id="reporting-admin-title">Weekly reporting</h2>
      <p>
        {data.schedule
          ? `Weeks run over ${data.hackathonName}'s own dates, ${data.schedule.startDate} to ${data.schedule.endDate}, in ${data.schedule.timezone}. Change those dates in Hackathons above; this panel is where a change reaches the stored weeks.`
          : "This hackathon has no dates recorded, so it has no reporting weeks."}
      </p>
      <p>{data.enrolled === 0 ? "No project is in weekly reporting yet." : `${data.enrolled} project${data.enrolled === 1 ? " is" : "s are"} in weekly reporting${data.paused ? `, ${data.paused} of them paused` : ""}.`}</p>

      <h3>Stored weeks</h3>
      {plan.periods.length === 0 && <p>No weeks are stored yet. They are created the first time a team enters reporting, or when you apply the schedule below.</p>}
      {plan.periods.length > 0 && (
        <ul className={styles.roster} aria-label="Reporting weeks">
          {plan.periods.map((period) => (
            <li key={period.id}>
              <span>
                Week {period.sequence}: {periodRangeLabel(period.startDate, period.endDate)}
                {period.mode === "submission" ? " (final submission period)" : ""}
              </span>
              <span className={styles.badge}>{period.closedAt ? "Closed" : "Open"}</span>
            </li>
          ))}
        </ul>
      )}

      <h3>Before you change the dates</h3>
      <p>{planSummary(plan)}</p>
      {plan.problems.length > 0 && (
        <>
          <p>Nothing is written while this is true. Change the hackathon dates again, or leave them, and the stored weeks stay exactly as they are.</p>
          <ul className={styles.roster} aria-label="Why these dates cannot be applied">
            {plan.problems.map((problem, index) => <li key={`${problem.kind}-${problem.sequence}-${index}`}><span>{problemLine(problem)}</span></li>)}
          </ul>
        </>
      )}
      {plan.conflicts.length > 0 && (
        <>
          <p>
            These weeks stay exactly as they are, whatever the dates say. Reporting is recorded against a week, so moving one would move updates
            and results that were written for a different set of days.
          </p>
          <ul className={styles.roster} aria-label="Weeks a date change cannot move">
            {plan.conflicts.map((conflict) => (
              <li key={conflict.periodId}>
                <span>
                  Week {conflict.sequence}, {periodRangeLabel(conflict.storedStartDate, conflict.storedEndDate)}
                  {conflict.generatedStartDate && conflict.generatedEndDate
                    ? `, which the dates would make ${periodRangeLabel(conflict.generatedStartDate, conflict.generatedEndDate)}`
                    : ", which the dates no longer have a week for"}
                  . Kept because {CONFLICT_REASONS[conflict.reason]} ({conflict.entries} update{conflict.entries === 1 ? "" : "s"}, {conflict.outcomes} recorded result{conflict.outcomes === 1 ? "" : "s"}).
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className={styles.actions}>
        <button className={styles.button} type="button" onClick={apply} disabled={applying}>
          {applying ? "Applying…" : "Apply the hackathon dates to the weeks"}
        </button>
      </div>

      <h3>Reporting settings</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const formData = new FormData(form);
          startSave(async () => {
            setSaved("");
            const result = await saveReportingConfiguration({
              finalPeriodStartDate: String(formData.get("finalStart") ?? ""),
              officialSubmissionDeadline: String(formData.get("officialDeadline") ?? ""),
              nudgeWeekday: Number(formData.get("nudgeWeekday")),
              nudgeTime: String(formData.get("nudgeTime") ?? "12:00"),
            });
            setSaved(result.ok ? "Saved. Check the weeks above, then apply." : result.error ?? "Could not save. Try again.");
          });
        }}
        aria-busy={saving}
      >
        <fieldset disabled={saving} className={styles.fieldset}>
          <div className={styles.grid}>
            <label className={styles.field}>
              Final submission period starts
              <input name="finalStart" type="date" defaultValue={data.config.finalPeriodStartDate ?? ""} />
            </label>
            <label className={styles.field}>
              {`Colosseum submission deadline, in ${timezone} (optional)`}
              {/* Shown and taken in the campaign timezone, both ways through
                  the same pair of functions: a datetime-local field carries no
                  offset, so slicing the stored UTC string would show the wrong
                  clock and save it back two hours out on the next edit. */}
              <input
                name="officialDeadline"
                type="datetime-local"
                defaultValue={data.config.officialSubmissionDeadline ? utcToZonedDateTime(data.config.officialSubmissionDeadline, timezone) : ""}
              />
            </label>
            <label className={styles.field}>
              Reminder day
              <select name="nudgeWeekday" defaultValue={data.config.nudgeWeekday}>
                {WEEKDAYS.map((day) => <option key={day.value} value={day.value}>{day.label}</option>)}
              </select>
            </label>
            <label className={styles.field}>
              Reminder time
              <input name="nudgeTime" type="time" defaultValue={data.config.nudgeTime} required />
            </label>
          </div>
          <p className={styles.muted}>
            The final period merges the last weeks into one submission-focused window that runs to the hackathon&apos;s end date. The Colosseum
            deadline is that platform&apos;s own cutoff and never moves these weeks; it only decides whether a submission counted as on time. Type
            it as the clock reads in {timezone}, which is how it is shown above and how it is stored.
            The reminder day and time decide when the Wednesday Captain reminder goes out, and a change takes effect for every week whose
            reminder has not been recorded yet.
          </p>
          <div className={styles.actions}>
            <button className={styles.secondary} type="submit">Save reporting settings</button>
          </div>
        </fieldset>
        {(saving || saved) && <div className={styles.feedback} role="status">{saving ? "Saving…" : saved}</div>}
      </form>

      <h3>Wednesday Captain reminders</h3>
      <p>
        {`Reminders go to Captains only, on ${WEEKDAYS.find((day) => day.value === data.config.nudgeWeekday)?.label ?? "the day set above"} at ${data.config.nudgeTime} ${timezone}, naming just the teams that still owe an update that week. Teams and admins are never messaged automatically.`}
      </p>
      <p>
        {data.botConfigured
          ? "The scheduled job runs every half hour and works out what is outstanding when it runs, so a late or missed run catches up on its own. Run it now if you would rather not wait."
          : "This deployment has no Telegram bot configured, so reminders are worked out and recorded here and nothing is delivered. Set the bot up and the waiting messages go out on the next run."}
      </p>
      <div className={styles.actions}>
        <button className={styles.secondary} type="button" onClick={runJobs} disabled={running}>
          {running ? "Running…" : "Run the reminder and closure job now"}
        </button>
      </div>
      {(running || ranSummary) && <div className={styles.feedback} role="status">{running ? "Running…" : ranSummary}</div>}
      {reminders.length === 0 && <p>No reminder has been recorded for this hackathon yet.</p>}
      {reminders.length > 0 && (
        <ul className={styles.roster} aria-label="Reminder history">
          {reminders.map((reminder) => {
            const reason = reminderReason(reminder);
            return (
              <li key={reminder.id}>
                <span>
                  {reminder.captainName}, week {reminder.periodSequence} ({periodRangeLabel(reminder.periodStartDate, reminder.periodEndDate)}).{" "}
                  {reminder.projectCount === 1 ? "1 team outstanding" : `${reminder.projectCount} teams outstanding`}.
                  {reason ? ` Not sent because ${reason}.` : ""}
                  {reminder.attempts > 1 ? ` ${reminder.attempts} attempts.` : ""}
                </span>
                <span className={styles.badge}>{REMINDER_STATES[reminder.state]}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
