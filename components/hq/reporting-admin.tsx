"use client";

import { useState, useTransition } from "react";
import { showToast } from "@/components/hq/toast";
import {
  applyReportingSchedule,
  saveReportingConfiguration,
  type ReportingScheduleView,
} from "@/lib/hq/actions/reporting-admin";
import type { ReportingAdminData } from "@/lib/hq/builder-admin-queries";
import type { ReportingPeriodConflict } from "@/lib/hq/reporting";
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
  return `Applying the hackathon dates would ${parts.join(", ")}.`;
}

export function ReportingAdmin({ data }: { data: ReportingAdminData }) {
  const [plan, setPlan] = useState(data.plan);
  const [applying, startApply] = useTransition();
  const [saving, startSave] = useTransition();
  const [saved, setSaved] = useState("");

  const apply = () =>
    startApply(async () => {
      const result: { ok: true; schedule: ReportingScheduleView } | { ok: false; error: string } = await applyReportingSchedule();
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      setPlan(result.schedule.plan);
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
              Colosseum submission deadline (optional)
              <input name="officialDeadline" type="datetime-local" defaultValue={(data.config.officialSubmissionDeadline ?? "").slice(0, 16)} />
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
            deadline is that platform&apos;s own cutoff and never moves these weeks; it only decides whether a submission counted as on time.
            The reminder day and time are stored for the Telegram reminders, which are not sending yet.
          </p>
          <div className={styles.actions}>
            <button className={styles.secondary} type="submit">Save reporting settings</button>
          </div>
        </fieldset>
        {(saving || saved) && <div className={styles.feedback} role="status">{saving ? "Saving…" : saved}</div>}
      </form>
    </section>
  );
}
