"use client";

import { useEffect, useState, useTransition } from "react";
import { showToast } from "@/components/hq/toast";
import {
  addAdminReportingUpdate,
  editAdminReportingUpdate,
  correctReportingOutcome,
  enableProjectReporting,
  loadEntryRevisions,
  loadMoreProjectUpdates,
  loadProjectReporting,
  setProjectReportingPaused,
  voidReportingUpdate,
  type ProjectReportingDetail,
} from "@/lib/hq/actions/reporting-admin";
import type { CaptainReach } from "@/lib/hq/builder-admin-queries";
import { SUBMISSION_LABELS } from "@/lib/hq/colosseum-snapshot";
import { fmtWhen } from "@/lib/hq/format";
import type { PeriodOutcome, ProjectReportingStatus, ReportingEntryView, ReportingPeriod, ReportingRevision } from "@/lib/hq/reporting";
import { mergeUpdatePages, missedLabel, periodRangeLabel, statusLabel } from "@/lib/hq/reporting-view";

/**
 * The Projects detail panel's weekly reporting block: every week, every
 * update including the sensitive and the removed ones, the saved versions
 * behind any update, and admin controls to enroll/pause reporting, create,
 * edit or remove updates, and correct a recorded week.
 *
 * Loaded when the row is opened rather than for every row on the board: the
 * board itself already carries each project's week from `reportingStatus`,
 * which is what the columns and filters read, and this is the rest. Admins
 * see everything here because the permission contract gives them full
 * access, which is also why every call below is an operator action.
 */

const microLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--label-3)",
};

const smallButton: React.CSSProperties = {
  border: "none",
  cursor: "pointer",
  padding: "5px 11px",
  fontSize: 12,
  fontWeight: 600,
  background: "var(--fill-3)",
  color: "var(--accent-deep)",
  minHeight: 40,
};

const smallField: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "6px 8px",
  border: "1px solid var(--sep)",
  background: "var(--card)",
  color: "var(--label-1)",
  fontSize: 13,
};

/** One composer for an operator's new update and corrections to saved text. */
export function AdminUpdateForm({ projectId, detail, entry, onDone, onCancel }: {
  projectId: string;
  detail: Pick<ProjectReportingDetail, "current" | "history">;
  entry?: ReportingEntryView;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const past = detail.history.filter(period => period.closed);
  const [selection, setSelection] = useState({ periodId: detail.current?.periodId ?? past[0]?.periodId ?? "", late: !detail.current });
  const { periodId, late } = selection;
  // Refreshing the list must not silently bless an old draft against a new
  // version, or change its audience. Only a conflict response advances this.
  const [draftBase] = useState({ version: entry?.version ?? 1, visibility: entry?.visibility ?? "shared" });
  const [body, setBody] = useState(entry?.body ?? "");
  const [visibility, setVisibility] = useState(entry?.visibility ?? "shared");
  const [confirmAudience, setConfirmAudience] = useState(false);
  const [conflict, setConflict] = useState<ReportingEntryView | null>(null);
  const [movedTo, setMovedTo] = useState<ReportingPeriod | null>(null);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const selectedClosedPeriod = !entry && !late ? past.find(period => period.periodId === periodId) : null;
  const sharing = (conflict ?? draftBase).visibility === "sensitive" && visibility === "shared";

  return (
    <form style={{ display: "grid", gap: 8, margin: "10px 0", fontSize: 13 }} onSubmit={event => {
      event.preventDefault();
      start(async () => {
        setError("");
        try {
          if (entry) {
            const result = await editAdminReportingUpdate({
              entryId: entry.id, body, visibility,
              expectedVersion: (conflict ?? draftBase).version,
              confirmAudienceChange: confirmAudience || undefined,
            });
            if (result.ok) { onDone(); return; }
            setError(result.error);
            if (result.reason === "conflict") { setConflict(result.current); setConfirmAudience(false); }
          } else {
            const result = await addAdminReportingUpdate({ projectId, body, visibility: "shared", ...(late ? { periodId } : { expectedPeriodId: periodId }) });
            if (result.ok) { setBody(""); onDone(); return; }
            setError(result.error);
            if (result.reason === "period_changed") setMovedTo(result.currentPeriod);
          }
        } catch {
          setError("The update could not be saved. Your text is still here; try again.");
        }
      });
    }}>
      {!entry && <label style={{ display: "grid", gap: 4 }}>Reporting week
        <select style={smallField} value={periodId} onChange={event => {
          setSelection({ periodId: event.target.value, late: past.some(period => period.periodId === event.target.value) });
          setMovedTo(null);
          setError("");
        }} disabled={pending} required>
          {!periodId && <option value="">No reporting week available</option>}
          {detail.current && <option value={detail.current.periodId}>Week {detail.current.periodSequence}: {periodRangeLabel(detail.current.startDate, detail.current.endDate)} (open)</option>}
          {movedTo && movedTo.id !== detail.current?.periodId && <option value={movedTo.id}>Week {movedTo.sequence}: {periodRangeLabel(movedTo.startDate, movedTo.endDate)} (open now)</option>}
          {past.map(period => <option key={period.periodId} value={period.periodId}>Week {period.periodSequence}: {periodRangeLabel(period.startDate, period.endDate)} (late update)</option>)}
        </select>
      </label>}
      {selectedClosedPeriod && <div role="status">
        Week {selectedClosedPeriod.periodSequence} ended while this draft was open. Choose the current week above, or confirm it belongs to the previous week.
        <button type="button" style={{ ...smallButton, marginTop: 6 }} disabled={pending} onClick={() => { setSelection({ periodId, late: true }); setMovedTo(null); setError(""); }}>
          Keep it in week {selectedClosedPeriod.periodSequence} as a late update
        </button>
      </div>}
      <label style={{ display: "grid", gap: 4 }}>{entry ? "Correct this update" : "Add an update"}
        <textarea style={{ ...smallField, resize: "vertical" }} rows={5} maxLength={4000} required value={body} onChange={event => setBody(event.target.value)} disabled={pending} />
      </label>
      {entry && <label style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 40 }}>
        <input type="checkbox" checked={visibility === "sensitive"} disabled={pending} onChange={event => { setVisibility(event.target.checked ? "sensitive" : "shared"); setConfirmAudience(false); }} />
        Sensitive: only the original author and admins can read this note.
      </label>}
      {sharing && <label style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 40 }}>
        <input type="checkbox" checked={confirmAudience} required disabled={pending} onChange={event => setConfirmAudience(event.target.checked)} />
        I confirm the team and its assigned Captain can read this note from now on.
      </label>}
      {late && !entry && <p style={{ margin: 0 }}>This late update stays with the selected week and does not erase a missed week.</p>}
      {conflict && <section aria-live="polite" style={{ border: "1px solid var(--sep)", padding: 10 }}>
        <strong>Saved now, version {conflict.version}</strong>
        <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{conflict.body}</p>
        <p>Your text is still above. Review this version before saving your correction again.</p>
      </section>}
      {movedTo && movedTo.id !== detail.current?.periodId && !entry && <p role="status" style={{ margin: 0 }}>The open week changed. Choose week {movedTo.sequence} above if this update belongs there; your text is still here.</p>}
      {error && <p role="alert" style={{ margin: 0, color: "var(--red)" }}>{error}</p>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button style={smallButton} disabled={pending || !body.trim() || (!entry && !periodId) || Boolean(selectedClosedPeriod) || (sharing && !confirmAudience)}>
          {pending ? "Saving…" : entry ? conflict ? "Save my correction anyway" : "Save correction" : late ? "Add late update" : "Add update"}
        </button>
        {onCancel && <button type="button" style={smallButton} disabled={pending} onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

/**
 * How reachable the assigned Captain is, on separate lines because these are
 * separate facts: the contact they approved for their teams, and whether the
 * bot could message them (a Telegram connection is not permission to use it).
 */
function CaptainLines({ captainName, reach }: { captainName: string; reach: CaptainReach | undefined }) {
  return (
    <>
      <div>Captain: {captainName}</div>
      <div>Contact for their teams: {reach?.contact ?? "none shared"}</div>
      <div>
        {reach?.telegram
          ? reach.botMessaging ? "Telegram connected, bot messages allowed." : "Telegram connected, bot messages not allowed yet."
          : "No Telegram connection, so the bot cannot reach them."}
      </div>
    </>
  );
}

/**
 * An entry's saved versions, on demand and a page at a time.
 *
 * Bodies stay out of every list read, so this is a separate call; and it
 * continues, because an entry edited more times than one page holds still has
 * a full history and an admin still has to be able to reach it.
 */
function Revisions({ entryId }: { entryId: string }) {
  const [revisions, setRevisions] = useState<ReportingRevision[] | null>(null);
  const [after, setAfter] = useState<number | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState("");

  const load = (from: number) =>
    start(async () => {
      setError("");
      try {
        const result = await loadEntryRevisions(entryId, from);
        if (!result.ok) { setError(result.error); return; }
        setRevisions([...(from ? revisions ?? [] : []), ...result.revisions]);
        setAfter(result.nextAfterVersion);
      } catch {
        setError("Saved versions could not be loaded. Try again.");
      }
    });

  if (revisions) {
    return (
      <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0 }}>
        {error && <li role="alert" style={{ color: "var(--red)", fontSize: 12 }}>{error}</li>}
        {revisions.map((revision) => (
          <li key={revision.version} style={{ fontSize: 12, color: "var(--label-2)", padding: "4px 0", borderTop: "1px solid var(--sep)" }}>
            <strong>Version {revision.version}</strong>, {revision.editorName}, {revision.createdAt.slice(0, 10)}
            {revision.visibility === "sensitive" ? ", sensitive" : ""}
            <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--label-1)" }}>{revision.body}</div>
          </li>
        ))}
        {revisions.length === 0 && <li style={{ fontSize: 12, color: "var(--label-3)" }}>No saved versions.</li>}
        {after != null && (
          <li>
            <button type="button" style={{ ...smallButton, marginTop: 6 }} disabled={pending} onClick={() => load(after)}>
              {pending ? "Loading…" : "More saved versions"}
            </button>
          </li>
        )}
      </ul>
    );
  }
  return (
    <>
    {error && <p role="alert" style={{ color: "var(--red)", fontSize: 12 }}>{error}</p>}
    <button type="button" style={{ ...smallButton, marginTop: 6 }} disabled={pending} onClick={() => load(0)}>
      {pending ? "Loading…" : "Saved versions"}
    </button>
    </>
  );
}

/** Removing an update: a reason first, then the button, like every other destructive control in Admin. */
function VoidUpdate({ entryId, onDone }: { entryId: string; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
      <input aria-label="Why this update is being removed" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why it is being removed" style={{ ...smallField, flex: 1, minWidth: 160 }} />
      <button
        type="button"
        style={smallButton}
        disabled={pending || reason.trim().length < 3}
        onClick={() =>
          start(async () => {
            const result = await voidReportingUpdate({ entryId, reason });
            if (result.ok) onDone();
            else showToast(result.error ?? "Could not remove this update.");
          })
        }
      >
        {pending ? "Removing…" : "Remove update"}
      </button>
    </div>
  );
}

/** Correcting a week that was recorded wrongly. The original stays; this writes the correction beside it. */
function CorrectOutcome({ periodId, projectId, outcome, onDone }: { periodId: string; projectId: string; outcome: PeriodOutcome; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const effective = outcome.correctedCompleted ?? outcome.completed;
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
      <input aria-label="Why this week is being corrected" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why this week is being corrected" style={{ ...smallField, flex: 1, minWidth: 160 }} />
      <button
        type="button"
        style={smallButton}
        disabled={pending || reason.trim().length < 3}
        onClick={() =>
          start(async () => {
            const result = await correctReportingOutcome({ periodId, projectId, completed: !effective, reason });
            if (result.ok) onDone();
            else showToast(result.error ?? "Could not correct this week.");
          })
        }
      >
        {pending ? "Saving…" : `Record as ${statusLabel(!effective)}`}
      </button>
    </div>
  );
}

export function ProjectReportingPanel({
  projectId,
  projectName,
  status,
  captainName,
  reach,
  timezone,
}: {
  projectId: string;
  projectName: string;
  /** The board's own row for this project, or null when it is not in weekly reporting. */
  status: ProjectReportingStatus | null;
  captainName: string;
  reach: CaptainReach | undefined;
  timezone: string;
}) {
  const [loadedDetail, setDetail] = useState<ProjectReportingDetail | null>(null);
  const detail = loadedDetail?.projectId === projectId ? loadedDetail : null;
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [pending, start] = useTransition();
  const [more, startMore] = useTransition();
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadProjectReporting(projectId).then((result) => {
      if (!live) return;
      if (result.ok) { setDetail(result.detail); setError(""); }
      else setError(result.error);
    }).catch(() => {
      if (live) setError("Reporting could not be loaded. Try again.");
    });
    return () => {
      live = false;
    };
  }, [projectId, reload]);

  // The rest of the updates, on request. The first read returns a page and a
  // cursor; discarding the cursor here would have made "every update" mean
  // "the newest fifty".
  const loadMoreUpdates = (cursor: string) =>
    startMore(async () => {
      try {
        const result = await loadMoreProjectUpdates({ projectId, cursor });
        if (!result.ok) { showToast(result.error); return; }
        setDetail((current) =>
          current?.projectId === projectId ? { ...current, entries: mergeUpdatePages(current.entries, result.entries), entriesCursor: result.nextCursor } : current,
        );
      } catch {
        showToast("Older updates could not be loaded. Try again.");
      }
    });

  const refresh = () => setReload((value) => value + 1);
  const outcomeFor = (periodId: string) => detail?.outcomes.find((outcome) => outcome.periodId === periodId);
  const missed = missedLabel(detail?.missedPeriods ?? status?.missedPeriods ?? 0);

  return (
    // Its own full-width row under the three columns above: the weeks and the
    // updates are lists that read badly in a 280px track, and wrapping into
    // one left a wide empty half beside them.
    <div style={{ gridColumn: "1 / -1", borderTop: "1px solid var(--sep)", paddingTop: 16 }}>
      <div style={{ ...microLabel, marginBottom: 8 }}>Weekly reporting</div>
      <div style={{ fontSize: 13, color: "var(--label-2)", marginBottom: 6, lineHeight: 1.5 }}>
        {captainName ? <CaptainLines captainName={captainName} reach={reach} /> : "No Captain assigned."}
      </div>

      {!detail && !error && <div style={{ fontSize: 13, color: "var(--label-3)" }}>Loading…</div>}
      {error && <div role="alert" style={{ fontSize: 13, color: "var(--red)" }}>{error} <button type="button" style={smallButton} onClick={refresh}>Retry</button></div>}

      {detail && !detail.enrolled && (
        <>
          <div style={{ fontSize: 13, marginBottom: 6 }}>{projectName} is not in weekly reporting.</div>
          <button
            type="button"
            style={smallButton}
            disabled={pending}
            onClick={() =>
              start(async () => {
                const result = await enableProjectReporting(projectId);
                if (result.ok) refresh();
                else showToast(result.error ?? "Could not add this project to reporting.");
              })
            }
          >
            {pending ? "Adding…" : "Add to weekly reporting"}
          </button>
        </>
      )}

      {/* Colosseum's own signal, beside the week and never mixed into it.
          Submitted/Not submitted and Updated/Not updated are separate
          vocabularies, which is why they are separate lines. */}
      {detail?.submission && (
        <div style={{ fontSize: 13, color: "var(--label-2)", marginBottom: 8, lineHeight: 1.5 }}>
          <div>
            Colosseum: {SUBMISSION_LABELS[detail.submission.submissionStatus]}
            {detail.submission.submittedAt ? `, submitted ${detail.submission.submittedAt.slice(0, 10)}` : ""}
          </div>
          <div>
            {detail.submission.sourceCheckedAt
              ? `Last read ${fmtWhen(detail.submission.sourceCheckedAt, timezone)}.`
              : "Never read from Colosseum."}
            {detail.submission.sourceStatus === "error" ? " The last check did not get through, so this is the last thing we knew." : ""}
          </div>
          {detail.reconciliations.map((row) => (
            <div key={row.periodId}>
              {row.state === "pending"
                ? `Final period: not established yet, ${row.attempts} ${row.attempts === 1 ? "attempt" : "attempts"} so far. Nothing recorded against the team.`
                : row.submissionStatus === "submitted"
                  ? row.onTime
                    ? `Final period: submitted on time.${row.outcomeCorrected ? " The recorded period was corrected, with an audit event." : ""}`
                    : "Final period: submitted after the deadline. The recorded period is unchanged."
                  : "Final period: Colosseum has no submission for this team."}
            </div>
          ))}
        </div>
      )}

      {detail?.enrolled && (
        <>
          <div style={{ fontSize: 13, marginBottom: 6 }}>
            {detail.paused
              ? "Paused. Future weeks stop counting; the weeks already recorded are unchanged."
              : detail.current
                ? `This week: ${statusLabel(detail.current.completed)}, ${periodRangeLabel(detail.current.startDate, detail.current.endDate)}.`
                : "No week is open right now."}
            {missed ? ` ${missed}.` : ""}
          </div>
          <button
            type="button"
            style={{ ...smallButton, marginBottom: 10 }}
            disabled={pending}
            onClick={() =>
              start(async () => {
                const result = await setProjectReportingPaused({ projectId, paused: !detail.paused });
                if (result.ok) refresh();
                else showToast(result.error ?? "Could not change this project's reporting.");
              })
            }
          >
            {detail.paused ? "Resume weekly reporting" : "Pause weekly reporting"}
          </button>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,280px),1fr))", gap: 20 }}>
          <div>
          <div style={{ ...microLabel, marginTop: 10, marginBottom: 6 }}>Weeks</div>
          {detail.history.length === 0 && <div style={{ fontSize: 13, color: "var(--label-3)" }}>No weeks are stored for this hackathon yet.</div>}
          {detail.history.map((period) => {
            const outcome = outcomeFor(period.periodId);
            return (
              <div key={period.periodId} style={{ padding: "6px 0", borderBottom: "1px solid var(--sep)", fontSize: 13 }}>
                <span style={{ fontWeight: 600 }}>Week {period.periodSequence}</span>{" "}
                <span style={{ color: "var(--label-2)" }}>{periodRangeLabel(period.startDate, period.endDate)}</span>{" "}
                <span style={{ color: period.completed ? "var(--green)" : "var(--label-2)" }}>{statusLabel(period.completed)}</span>
                {/* An excused week is not a missed one: the project was
                    paused, and the pause is recorded on the closed week so
                    lifting it later cannot turn the week into a miss. */}
                {period.exempt ? <span style={{ color: "var(--label-3)" }}> (paused, not counted)</span> : null}
                {period.closed ? <span style={{ color: "var(--label-3)" }}> (closed)</span> : null}
                {outcome?.correctionReason ? (
                  <div style={{ fontSize: 12, color: "var(--label-3)" }}>
                    Recorded as {statusLabel(outcome.completed)} at the time, corrected because: {outcome.correctionReason}
                  </div>
                ) : null}
                {outcome ? <CorrectOutcome periodId={period.periodId} projectId={projectId} outcome={outcome} onDone={refresh} /> : null}
              </div>
            );
          })}

          </div>
          <div>
          <div style={{ ...microLabel, marginTop: 10, marginBottom: 6 }}>Updates</div>
          <AdminUpdateForm key={projectId} projectId={projectId} detail={detail} onDone={refresh} />
          {detail.entries.length === 0 && <div style={{ fontSize: 13, color: "var(--label-3)" }}>No updates yet.</div>}
          {detail.entries.map((entry) => (
            <div key={entry.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--sep)" }}>
              <div style={{ fontSize: 12, color: "var(--label-3)" }}>
                Week {entry.periodSequence}, {entry.authorName}, {fmtWhen(entry.submittedAt, timezone)}
                {entry.edited ? `, edited (version ${entry.version})` : ""}
                {entry.visibility === "sensitive" ? ", sensitive" : ""}
                {entry.late ? ", late" : ""}
                {entry.voided ? ", removed" : ""}
              </div>
              <div style={{ fontSize: 13, whiteSpace: "pre-wrap", overflowWrap: "anywhere", marginTop: 2, color: entry.voided ? "var(--label-3)" : "var(--label-1)" }}>{entry.body}</div>
              <Revisions entryId={entry.id} />
              {!entry.voided && (editingId === entry.id
                ? <AdminUpdateForm key={entry.id} projectId={projectId} detail={detail} entry={entry} onCancel={() => setEditingId(null)} onDone={() => { setEditingId(null); refresh(); }} />
                : <button type="button" style={{ ...smallButton, marginLeft: 8 }} onClick={() => setEditingId(entry.id)}>Edit update</button>)}
              {!entry.voided && <VoidUpdate entryId={entry.id} onDone={refresh} />}
            </div>
          ))}
          {detail.entriesCursor && (
            <button type="button" style={{ ...smallButton, marginTop: 8 }} disabled={more} onClick={() => loadMoreUpdates(detail.entriesCursor!)}>
              {more ? "Loading…" : "Older updates"}
            </button>
          )}
          </div>
          </div>
        </>
      )}
    </div>
  );
}
