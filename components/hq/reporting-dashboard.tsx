"use client";

import Link from "next/link";
import type { MemberWeekSummary } from "@/lib/hq/reporting-surface";
import { deadlineLabel, missedLabel, periodRangeLabel, shouldPromptUpdate, statusLabel } from "@/lib/hq/reporting-view";
import styles from "./builder-shell.module.css";

/**
 * The weekly update line on the HQ home page.
 *
 * The plan's login experience is a prompt for the weekly update, and it used
 * to exist only on the team detail screen: someone who signed in and stayed
 * on the dashboard saw a verification badge and an Open team button, and
 * nothing about the update they owed. This is the same statement the team
 * page makes, made where people actually land, with the action beside it.
 *
 * The prompt styling is reserved for the Monday and Tuesday of an open,
 * incomplete week, exactly as `shouldPromptUpdate` decides it on the team
 * page; every other day still says plainly whether the week is done. Nothing
 * is dismissible here, because this is the state of the week rather than a
 * notification about it.
 */
export function DashboardWeek({ summary, nowMs }: { summary: MemberWeekSummary; nowMs: number }) {
  if (!summary.enrolled || summary.paused) return null;
  const { current } = summary;
  const missed = missedLabel(summary.missedPeriods);
  const nudge = shouldPromptUpdate({ current, atMs: nowMs, timezone: summary.timezone, paused: summary.paused });

  if (!current) {
    return missed ? <p>{summary.projectName}: {missed} in this hackathon.</p> : null;
  }

  return (
    <section
      className={nudge ? styles.notice : undefined}
      role={nudge ? "status" : undefined}
      aria-label={`This week for ${summary.projectName}`}
    >
      <span className={styles.status}>{statusLabel(current.completed)}</span>
      <p>
        {summary.projectName}, {periodRangeLabel(current.startDate, current.endDate)}. Due by the end of {deadlineLabel(current.endDate)}.
        {missed ? ` ${missed} earlier in this hackathon.` : ""}
      </p>
      {!current.completed && (
        <div className={styles.actions}>
          <Link className={styles.button} href={`/hq/team/${summary.projectId}#update-${summary.projectId}`}>
            Add this week&apos;s update
          </Link>
        </div>
      )}
    </section>
  );
}
