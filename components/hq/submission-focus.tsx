"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { refreshBuilderTeam } from "@/lib/hq/actions/builders";
import type { SubmissionFocusView } from "@/lib/hq/reporting-surface";
import { periodRangeLabel } from "@/lib/hq/reporting-view";
import {
  checklistSummary,
  REQUIREMENT_LABELS,
  SUBMISSION_COPY,
  SUBMISSION_STATE_COPY,
  sourceFreshnessLine,
  submissionDeadlineLabel,
  type ChecklistItem,
} from "@/lib/hq/submission-readiness";
import styles from "./builder-shell.module.css";
import dashboard from "./team-reporting.module.css";

/**
 * The final period, for a team and for its Captain: what has been submitted,
 * by when, what materials there are, and one button to ask Colosseum again.
 *
 * Every rule is the server's. This file decides wording and layout over the
 * `SubmissionFocusView` it is handed, and it is careful about one thing in
 * particular: a complete checklist is never presented as a submission.
 * `SUBMISSION_STATE_COPY` says what Colosseum actually reports, the checklist
 * says what the project has ready, and `readinessNotSubmission` says that the
 * two are not the same thing. The badge above them comes from
 * `submissionStatus`, which only `interpretSubmission` ever writes.
 *
 * The refresh is a button, not a timer. The plan forbids polling Colosseum
 * from every browser tab; the scheduled job does the bounded background work
 * when an admin has configured an interval, and this is the person asking.
 */

const TONE: Record<SubmissionFocusView["submissionStatus"], string> = {
  submitted: "#2a604a",
  not_submitted: "#a52b16",
  not_checked: "#57534a",
};

const STATE_LABEL: Record<SubmissionFocusView["submissionStatus"], string> = {
  submitted: "Submitted",
  not_submitted: "Not submitted",
  not_checked: "Not checked",
};

/** One material: what it is, whether this edition asks for it, and its own link. */
function Material({ item }: { item: ChecklistItem }) {
  return (
    <div className={styles.row}>
      <div style={{ minWidth: 0 }}>
        {item.url
          ? <a className={styles.inlineLink} href={item.url} target="_blank" rel="noopener noreferrer">{item.label}</a>
          : item.label}
        <small>
          {REQUIREMENT_LABELS[item.requirement]}
          {item.sharedWith.length > 0 ? `. ${SUBMISSION_COPY.sharedLinkPrefix} ${item.sharedWith.join(", ")}` : ""}
        </small>
      </div>
      <span>{item.present ? "Added" : "Missing"}</span>
    </div>
  );
}

export function SubmissionFocus({ focus, canRefresh = true, variant = "default" }: { focus: SubmissionFocusView; canRefresh?: boolean; variant?: "default" | "dashboard" }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, start] = useTransition();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const summary = checklistSummary(focus.items);

  const recheck = () =>
    start(async () => {
      setError("");
      setMessage("");
      let result;
      try { result = await refreshBuilderTeam({ projectId: focus.projectId, hackathonId: focus.hackathonId }); } catch {
        setError("The submission could not be checked. Please try again.");
        return;
      }
      if (result.ok) {
        setMessage(SUBMISSION_COPY.rechecked);
        router.refresh();
        return;
      }
      setError(result.error);
    });

  if (variant === "dashboard") {
    return (
      <section className={`${dashboard.dashboard} ${dashboard.submission}`} aria-labelledby={`submission-${focus.projectId}`}>
        <div className={dashboard.sectionHeader}>
          <div>
            <h2 id={`submission-${focus.projectId}`}>Submission</h2>
            <p className={dashboard.meta}>{focus.sourceStatus === "error" ? "Last known: " : ""}{STATE_LABEL[focus.submissionStatus]}</p>
          </div>
          <a className={dashboard.primary} href={focus.projectUrl} target="_blank" rel="noopener noreferrer">Open Colosseum</a>
        </div>
        <p className={dashboard.deadline}>
          Deadline: {submissionDeadlineLabel(focus.deadlineIsOfficial ? focus.deadline : null, focus.timezone, focus.period.endDate)}
          {focus.deadlineIsOfficial ? ` (${focus.timezone})` : ""}
        </p>
        {focus.reconciliation?.state === "pending" && <p className={dashboard.inlineNotice} role="status">Waiting for Colosseum confirmation.</p>}
        <button type="button" className={dashboard.textButton} aria-expanded={detailsOpen} aria-controls={`submission-details-${focus.projectId}`} onClick={() => setDetailsOpen(!detailsOpen)}>
          {detailsOpen ? "Hide details" : "View details"}
          <span className={dashboard.chevron} aria-hidden="true" />
        </button>
        <div id={`submission-details-${focus.projectId}`} className={dashboard.submissionDetails} hidden={!detailsOpen}>
          <p>{SUBMISSION_STATE_COPY[focus.submissionStatus]}</p>
          {focus.completedBySubmission && <p>This submission completes the final period.</p>}
          {focus.submissionStatus === "submitted" && focus.onTime === false && <p>Submitted after the deadline.</p>}
          <h3>Materials</h3>
          {summary.requirementsUnknown && <p>Requirements have not been confirmed.</p>}
          <div className={dashboard.materials}>{focus.items.map((item) => <Material key={item.key} item={item} />)}</div>
          <p>Adding materials does not submit your project.</p>
          <p>{sourceFreshnessLine(focus)}</p>
          {canRefresh && (
            <button type="button" className={dashboard.secondary} disabled={pending} aria-busy={pending} onClick={recheck}>
              {pending ? "Checking…" : "Check status"}
            </button>
          )}
          {error && <p role="alert" className={dashboard.error}>{error}</p>}
          {message && <p role="status" className={dashboard.saved}>Status checked.</p>}
        </div>
      </section>
    );
  }

  return (
    <section className={styles.card} aria-labelledby={`submission-${focus.projectId}`}>
      <h3 id={`submission-${focus.projectId}`}>{SUBMISSION_COPY.heading}</h3>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: TONE[focus.submissionStatus], fontWeight: 600 }}>
        <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: "50%", background: "currentColor" }} />
        {STATE_LABEL[focus.submissionStatus]}
      </span>
      <p>{SUBMISSION_STATE_COPY[focus.submissionStatus]}</p>
      {focus.open && <p>{SUBMISSION_COPY.intro}</p>}
      <p>
        {periodRangeLabel(focus.period.startDate, focus.period.endDate)}
        {". "}
        Deadline: {submissionDeadlineLabel(focus.deadlineIsOfficial ? focus.deadline : null, focus.timezone, focus.period.endDate)}
        {focus.deadlineIsOfficial ? " on Colosseum." : "."}
      </p>
      {focus.completedBySubmission && <p role="status">{SUBMISSION_COPY.completedBySubmission}</p>}
      {focus.submissionStatus === "submitted" && focus.onTime === false && <p>{SUBMISSION_COPY.lateSubmission}</p>}
      {focus.open && <p>{SUBMISSION_COPY.updateStillOpen}</p>}
      {focus.reconciliation?.state === "pending" && (
        <p className={styles.notice} role="status">{SUBMISSION_COPY.reconciliationPending}</p>
      )}

      <h4>{SUBMISSION_COPY.materialsHeading}</h4>
      {summary.requirementsUnknown && <p>{SUBMISSION_COPY.unknownRequirements}</p>}
      {focus.items.map((item) => <Material key={item.key} item={item} />)}
      <p>{SUBMISSION_COPY.readinessNotSubmission}</p>

      <p>
        <a className={styles.inlineLink} href={focus.projectUrl} target="_blank" rel="noopener noreferrer">
          {SUBMISSION_COPY.openSubmission}
        </a>
      </p>
      <p>{sourceFreshnessLine(focus)}</p>
      {canRefresh && (
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} disabled={pending} onClick={recheck}>
            {pending ? SUBMISSION_COPY.rechecking : SUBMISSION_COPY.recheck}
          </button>
        </div>
      )}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {message && <p role="status" className={styles.success}>{message}</p>}
    </section>
  );
}
