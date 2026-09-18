"use client";

import { useState, useTransition } from "react";
import { showToast } from "@/components/hq/toast";
import { loadMoreReminderDeliveries, runReportingJobsNow, type RunJobsResult } from "@/lib/hq/actions/jobs";
import {
  applyReportingSchedule,
  readColosseumDeadline,
  saveReportingConfiguration,
  type ReportingScheduleView,
} from "@/lib/hq/actions/reporting-admin";
import type { ReportingAdminData } from "@/lib/hq/builder-admin-queries";
import type { ReminderDeliveryView } from "@/lib/hq/jobs";
import type { ReportingPeriod } from "@/lib/hq/reporting";
import { utcToZonedDateTime } from "@/lib/hq/reporting-periods";
import { fmtRetryAt, shortPeriodRange } from "@/lib/hq/reporting-view";
import {
  MATERIAL_KEYS, MATERIAL_LABELS, REQUIREMENT_LABELS, materialRequirements, type MaterialKey, type MaterialRequirement,
} from "@/lib/hq/submission-readiness";
import styles from "./builder-admin.module.css";

/**
 * Admin's three reporting sections: the stored weeks, the settings that are
 * not the edition's own dates, and the Captain reminder history.
 *
 * The reporting window is `hq_hackathons.start_date`/`end_date` and the
 * timezone is `hq_settings.timezone`, both edited above in this same page.
 * Nothing here copies either: that would be the competing source of truth
 * the data contract forbids. What Reporting weeks adds is the step between
 * changing those dates and the stored weeks changing, which the plan
 * requires: `previewReportingPeriods` says what applying them would add,
 * move or remove, and refuses a change that would leave a day in no week or
 * in two. Applying is a separate, explicit press.
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

const REQUIREMENTS: MaterialRequirement[] = ["required", "optional", "unknown"];

type WeekState = "closed" | "open" | "upcoming";

/**
 * A week's pill is decided by the calendar, not by `closedAt`: a week whose
 * last day has passed reads Closed whether or not the closure job has run,
 * which is the answer an admin looking at the dates expects. `today` is the
 * campaign-timezone date the server rendered with, so the client agrees.
 */
function weekState(period: ReportingPeriod, today: string): WeekState {
  if (today > period.endDate) return "closed";
  return today >= period.startDate ? "open" : "upcoming";
}

const WEEK_LABELS: Record<WeekState, string> = { closed: "Closed", open: "Open", upcoming: "Upcoming" };
const WEEK_PILLS: Record<WeekState, string> = { closed: styles.pill, open: `${styles.pill} ${styles.pillGreen}`, upcoming: `${styles.pill} ${styles.pillFaint}` };

/** "7 projects report, 1 paused." */
function enrolledLine(enrolled: number, paused: number): string {
  return `${enrolled} project${enrolled === 1 ? "" : "s"} report${enrolled === 1 ? "s" : ""}, ${paused} paused.`;
}

/** What applying the current dates would do, in one sentence rather than three counts. */
function planSummary(plan: ReportingAdminData["plan"]): string {
  const parts: string[] = [];
  if (plan.added) parts.push(`add ${plan.added} week${plan.added === 1 ? "" : "s"}`);
  if (plan.updated) parts.push(`move ${plan.updated} week${plan.updated === 1 ? "" : "s"}`);
  if (plan.removed) parts.push(`remove ${plan.removed} week${plan.removed === 1 ? "" : "s"}`);
  if (!parts.length) return "Weeks already match the hackathon dates.";
  const change = `Applying the hackathon dates would ${parts.join(", ")}.`;
  // A week that already holds updates keeps its own dates whatever the
  // hackathon dates say, so the weeks around it can leave a day in no week
  // at all, or in two. That is refused as a whole.
  return plan.blocked ? `${change} Refused, because it would leave a day in no week or in two.` : change;
}

/**
 * The three pills. Every one of these is about the MESSAGE, never about the
 * week: a Captain nobody could reach does not make a team's week anything
 * other than Updated or Not updated. A queued delivery is Retrying whether
 * it has been tried yet or not; what is known about it goes in the text.
 */
function reminderPill(state: ReminderDeliveryView["state"]): { label: string; className: string } {
  if (state === "sent") return { label: "Sent", className: `${styles.pill} ${styles.pillGreen}` };
  if (state === "queued") return { label: "Retrying", className: `${styles.pill} ${styles.pillOrange}` };
  return { label: "Not sent", className: `${styles.pill} ${styles.pillRed}` };
}

/** Why a reminder was not sent, as a comma phrase for the reminder row. */
const REMINDER_REASONS: Record<string, string> = {
  nothing_outstanding: "every team had already updated",
  no_assignments: "no teams assigned",
  capability_revoked: "Captain access removed",
  telegram_disconnected: "Telegram not connected",
  messaging_disabled: "bot messages turned off",
  no_chat: "no chat with the bot yet",
  chat_not_bound: "bot chat not linked to their Telegram",
  chat_changed: "moved to a new bot chat",
  not_authorized: "no longer holds the team named",
  period_over: "the week ended first",
  too_old: "waited too long to still be accurate",
  message_too_long: "message too long for Telegram",
  edition_archived: "hackathon archived",
  reminder_missing: "reminder record missing",
};

/**
 * "Week 1, 2 teams outstanding, bot messages turned off": the week, the
 * count, then whatever is known about a delivery that has not landed. The
 * reason falls back to Telegram's own code rather than swallowing something
 * there is no phrase for.
 */
function reminderLine(reminder: ReminderDeliveryView, timezone: string): string {
  const parts = [`Week ${reminder.periodSequence}`, `${reminder.projectCount} team${reminder.projectCount === 1 ? "" : "s"} outstanding`];
  if (reminder.reason && reminder.state !== "queued") parts.push(REMINDER_REASONS[reminder.reason] ?? `Telegram refused it (${reminder.reason})`);
  if (reminder.deliveryUncertain) parts.push("no answer from Telegram");
  if (reminder.state === "queued" && reminder.nextAttemptAt) parts.push(`retry ${fmtRetryAt(reminder.nextAttemptAt, timezone)}`);
  return parts.join(", ");
}

export function ReportingAdmin({ data }: { data: ReportingAdminData }) {
  const [plan, setPlan] = useState(data.plan);
  const timezone = data.schedule?.timezone ?? "Europe/Amsterdam";
  const [applying, startApply] = useTransition();
  const [saving, startSave] = useTransition();
  const [saved, setSaved] = useState("");
  const [saveError, setSaveError] = useState(false);
  // Shown and taken in the campaign timezone, both ways through the same
  // pair of functions: a datetime-local field carries no offset, so slicing
  // the stored UTC string would show the wrong clock and save it back two
  // hours out on the next edit. Controlled, so a read from Colosseum can land
  // in the field without a reload.
  const [deadline, setDeadline] = useState(
    data.config.officialSubmissionDeadline ? utcToZonedDateTime(data.config.officialSubmissionDeadline, timezone) : "",
  );
  // Which materials this edition asks for. Nothing is required until an
  // admin says so: Colosseum publishes no per-field requirement HQ can read,
  // so an edition nobody has configured shows every material as Not known
  // rather than inventing a checklist.
  const [materials, setMaterials] = useState<Record<MaterialKey, MaterialRequirement>>(() => materialRequirements(data.config));
  const [readingDeadline, startDeadline] = useTransition();
  const [deadlineNote, setDeadlineNote] = useState("");
  const [deadlineError, setDeadlineError] = useState(false);
  const [reminders, setReminders] = useState(data.reminders);
  const [running, startRun] = useTransition();
  const [ranSummary, setRanSummary] = useState("");
  const [reminderLimit, setReminderLimit] = useState(reminders.length);
  const [loadingMore, startLoadMore] = useTransition();

  const apply = () =>
    startApply(async () => {
      const result: { ok: true; schedule: ReportingScheduleView } | { ok: false; error: string } = await applyReportingSchedule();
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      setPlan(result.schedule.plan);
      if (result.schedule.plan.blocked) {
        showToast("Nothing was changed. These dates would leave a gap or an overlap between the weeks.");
        return;
      }
      showToast(
        result.schedule.plan.conflicts.length
          ? `Applied. ${result.schedule.plan.conflicts.length} week${result.schedule.plan.conflicts.length === 1 ? " was" : "s were"} left exactly as recorded.`
          : "Applied.",
      );
    });

  // Colosseum's own cutoff, read from the edition's listing envelope rather
  // than typed. A failure keeps its own sentence and never erases a deadline
  // an admin already entered.
  const readDeadline = () =>
    startDeadline(async () => {
      setDeadlineNote("");
      setDeadlineError(false);
      const result = await readColosseumDeadline();
      if (result.ok) {
        if (result.deadline) setDeadline(utcToZonedDateTime(result.deadline, timezone));
        setDeadlineNote("Read from Colosseum and saved");
        return;
      }
      setDeadlineError(true);
      setDeadlineNote(result.error);
    });

  const runJobs = () =>
    startRun(async () => {
      setRanSummary("");
      const result: RunJobsResult = await runReportingJobsNow();
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      setReminders(result.view.deliveries);
      const { closures, reminders: counts, delivery, submissions } = result.summary;
      const parts = [
        `${counts.due} reminder${counts.due === 1 ? "" : "s"} were due`,
        `${counts.queued} prepared`,
        `${counts.skipped} not sent`,
        `${closures.closed} week${closures.closed === 1 ? "" : "s"} closed`,
      ];
      if (delivery) parts.push(`${delivery.sent} delivered`);
      if (submissions.refreshed.attempted) parts.push(`${submissions.refreshed.refreshed} submission check${submissions.refreshed.refreshed === 1 ? "" : "s"} refreshed`);
      if (submissions.reconciled.attempted) {
        parts.push(`${submissions.reconciled.resolved} submission${submissions.reconciled.resolved === 1 ? "" : "s"} confirmed`);
        if (submissions.reconciled.stillPending) parts.push(`${submissions.reconciled.stillPending} still not established`);
        if (submissions.reconciled.corrected) parts.push(`${submissions.reconciled.corrected} recorded period${submissions.reconciled.corrected === 1 ? "" : "s"} corrected`);
      }
      setRanSummary(`${parts.join(", ")}.`);
    });

  const showMoreReminders = () =>
    startLoadMore(async () => {
      const next = reminderLimit + 50;
      const result = await loadMoreReminderDeliveries(next);
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      setReminders(result.view.deliveries);
      setReminderLimit(next);
    });

  const nudgeDay = WEEKDAYS.find((day) => day.value === data.config.nudgeWeekday)?.label ?? "the day set above";

  return (
    <>
      <section className={`${styles.section} ${styles.sectionLg}`} aria-labelledby="reporting-weeks-title">
        <h2 id="reporting-weeks-title">Reporting weeks</h2>
        <p>{enrolledLine(data.enrolled, data.paused)}</p>
        <ol className={styles.weeks} aria-label="Reporting weeks">
          {plan.periods.map((period) => {
            const state = weekState(period, data.today);
            return (
              <li key={period.id}>
                <span className={styles.kicker}>Week {period.sequence}</span>
                <span className={styles.weekRange}>
                  <span className={styles.strong}>{shortPeriodRange(period.startDate, period.endDate)}</span>
                  {period.mode === "submission" && <span className={styles.hint}>Final submission period</span>}
                </span>
                <span className={WEEK_PILLS[state]}>{WEEK_LABELS[state]}</span>
              </li>
            );
          })}
        </ol>
        <div className={`${styles.actions} ${styles.actionsWide}`} style={{ marginTop: 20 }}>
          <button
            className={`${styles.secondary} ${styles.buttonLg}`}
            type="button"
            onClick={apply}
            disabled={applying}
            style={{ opacity: applying ? 0.55 : 1 }}
          >
            {applying ? "Applying…" : "Apply hackathon dates"}
          </button>
          <span className={styles.planSummary}>{planSummary(plan)}</span>
        </div>
      </section>

      <section className={`${styles.section} ${styles.sectionLg}`} aria-labelledby="reporting-settings-title">
        <h2 id="reporting-settings-title">Reporting settings</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            startSave(async () => {
              setSaved("");
              setSaveError(false);
              const refresh = String(formData.get("submissionRefresh") ?? "").trim();
              const result = await saveReportingConfiguration({
                finalPeriodStartDate: String(formData.get("finalStart") ?? ""),
                officialSubmissionDeadline: deadline,
                nudgeWeekday: Number(formData.get("nudgeWeekday")),
                nudgeTime: String(formData.get("nudgeTime") ?? "12:00"),
                // Both arrays are always sent: an untouched form would
                // otherwise read as "leave the materials alone" and setting
                // the last one back to Not known would never save.
                requiredMaterials: MATERIAL_KEYS.filter((key) => materials[key] === "required"),
                optionalMaterials: MATERIAL_KEYS.filter((key) => materials[key] === "optional"),
                submissionRefreshMinutes: refresh === "" ? 0 : Number(refresh),
              });
              setSaveError(!result.ok);
              setSaved(result.ok ? "Saved" : result.error ?? "Could not save. Try again.");
            });
          }}
          aria-busy={saving}
        >
          <fieldset disabled={saving} className={styles.fieldset}>
            <div className={`${styles.grid} ${styles.gridSettings}`}>
              <label className={styles.field}>
                <span className={styles.kicker}>Final period starts</span>
                <input name="finalStart" type="date" defaultValue={data.config.finalPeriodStartDate ?? ""} />
              </label>
              <label className={styles.field}>
                <span className={styles.kicker}>Reminder day</span>
                <select name="nudgeWeekday" defaultValue={data.config.nudgeWeekday}>
                  {WEEKDAYS.map((day) => <option key={day.value} value={day.value}>{day.label}</option>)}
                </select>
              </label>
              <label className={styles.field}>
                <span className={styles.kicker}>Reminder time</span>
                <input name="nudgeTime" type="time" defaultValue={data.config.nudgeTime} required />
              </label>
              <label className={styles.field}>
                <span className={styles.kicker}>Auto-check submissions</span>
                <input name="submissionRefresh" type="number" min={0} step={5} placeholder="Off" defaultValue={data.config.submissionRefreshMinutes ?? ""} />
                <span className={styles.hint}>Minutes, final period only</span>
              </label>
            </div>
            <div className={styles.settingsBlock}>
              <label className={styles.kicker} htmlFor="reporting-deadline">Colosseum deadline</label>
              <div className={styles.deadline}>
                <input id="reporting-deadline" name="officialDeadline" type="datetime-local" value={deadline} onChange={(event) => setDeadline(event.target.value)} />
                <button className={`${styles.secondary} ${styles.buttonLg}`} type="button" onClick={readDeadline} disabled={readingDeadline}>
                  {readingDeadline ? "Asking Colosseum…" : "Read from Colosseum"}
                </button>
              </div>
              <p className={styles.hintLine}>Colosseum&apos;s cutoff. Does not move the weeks.</p>
              {deadlineNote && (
                <div className={deadlineError ? `${styles.note} ${styles.error}` : styles.note} role={deadlineError ? "alert" : "status"}>{deadlineNote}</div>
              )}
            </div>
            <div className={styles.settingsBlock}>
              <span className={styles.kicker}>Submission materials</span>
              <div className={styles.materials}>
                {MATERIAL_KEYS.map((key) => (
                  <div key={key} className={styles.materialRow}>
                    <span>{MATERIAL_LABELS[key]}</span>
                    <div className={styles.segmented} role="group" aria-label={MATERIAL_LABELS[key]}>
                      {REQUIREMENTS.map((value) => (
                        <button
                          key={value}
                          type="button"
                          className={materials[key] === value ? styles.segmentedOn : undefined}
                          aria-pressed={materials[key] === value}
                          onClick={() => setMaterials((current) => ({ ...current, [key]: value }))}
                        >
                          {REQUIREMENT_LABELS[value]}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className={`${styles.actions} ${styles.actionsWide}`} style={{ marginTop: 24 }}>
              <button className={`${styles.button} ${styles.buttonLg}`} type="submit">Save settings</button>
              {(saving || saved) && (
                <span className={saveError ? `${styles.status} ${styles.error}` : styles.status} role={saveError ? "alert" : "status"}>
                  {saving ? "Saving…" : saved}
                </span>
              )}
            </div>
          </fieldset>
        </form>
      </section>

      <section className={`${styles.section} ${styles.sectionLg}`} aria-labelledby="captain-reminders-title">
        <div className={`${styles.header} ${styles.headerTop}`}>
          <div>
            <h2 id="captain-reminders-title">Captain reminders</h2>
            <p>Each {nudgeDay}, Captains are told which teams still owe an update.</p>
          </div>
          <button className={`${styles.secondary} ${styles.buttonLg}`} type="button" onClick={runJobs} disabled={running} style={{ flex: "none" }}>
            {running ? "Running…" : "Run now"}
          </button>
        </div>
        {ranSummary && <div className={styles.summary} role="status">{ranSummary}</div>}
        <ul className={styles.reminders} aria-label="Reminder history">
          {reminders.map((reminder) => {
            const pill = reminderPill(reminder.state);
            return (
              <li key={reminder.id}>
                <span className={styles.reminderText}>
                  <span className={styles.strong}>{reminder.captainName}</span>
                  <span className={styles.reminderDetail}>{reminderLine(reminder, timezone)}</span>
                </span>
                <span className={pill.className}>{pill.label}</span>
              </li>
            );
          })}
        </ul>
        {reminders.length >= reminderLimit && reminders.length > 0 && (
          <div className={styles.actions}>
            <button className={`${styles.secondary} ${styles.buttonLg}`} type="button" onClick={showMoreReminders} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Show earlier reminders"}
            </button>
          </div>
        )}
      </section>
    </>
  );
}
