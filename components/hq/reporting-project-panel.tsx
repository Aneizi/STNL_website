"use client";

import { useEffect, useState, useTransition } from "react";
import { showToast } from "@/components/hq/toast";
import {
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
import { fmtWhen } from "@/lib/hq/format";
import type { PeriodOutcome, ProjectReportingStatus, ReportingRevision } from "@/lib/hq/reporting";
import { missedLabel, periodRangeLabel, statusLabel } from "@/lib/hq/reporting-view";

/**
 * The Projects detail panel's weekly reporting block: every week, every
 * update including the sensitive and the removed ones, the saved versions
 * behind any update, and the four admin controls (add to reporting, pause,
 * remove an update, correct a recorded week).
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

  const load = (from: number) =>
    start(async () => {
      const result = await loadEntryRevisions(entryId, from);
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      setRevisions([...(from ? revisions ?? [] : []), ...result.revisions]);
      setAfter(result.nextAfterVersion);
    });

  if (revisions) {
    return (
      <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0 }}>
        {revisions.map((revision) => (
          <li key={revision.version} style={{ fontSize: 12, color: "var(--label-2)", padding: "4px 0", borderTop: "1px solid var(--sep)" }}>
            <strong>Version {revision.version}</strong>, {revision.editorName}, {revision.createdAt.slice(0, 10)}
            {revision.visibility === "sensitive" ? ", sensitive" : ""}
            <div style={{ whiteSpace: "pre-wrap", color: "var(--label-1)" }}>{revision.body}</div>
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
    <button type="button" style={{ ...smallButton, marginTop: 6 }} disabled={pending} onClick={() => load(0)}>
      {pending ? "Loading…" : "Saved versions"}
    </button>
  );
}

/** Removing an update: a reason first, then the button, like every other destructive control in Admin. */
function VoidUpdate({ entryId, onDone }: { entryId: string; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
      <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why it is being removed" style={{ ...smallField, flex: 1, minWidth: 160 }} />
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
      <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why this week is being corrected" style={{ ...smallField, flex: 1, minWidth: 160 }} />
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
  const [detail, setDetail] = useState<ProjectReportingDetail | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [pending, start] = useTransition();
  const [more, startMore] = useTransition();

  useEffect(() => {
    let live = true;
    loadProjectReporting(projectId).then((result) => {
      if (!live) return;
      if (result.ok) setDetail(result.detail);
      else setError(result.error);
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
      const result = await loadMoreProjectUpdates({ projectId, cursor });
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      setDetail((current) =>
        current ? { ...current, entries: [...current.entries, ...result.entries], entriesCursor: result.nextCursor } : current,
      );
    });

  const refresh = () => setReload((value) => value + 1);
  const outcomeFor = (periodId: string) => detail?.outcomes.find((outcome) => outcome.periodId === periodId);
  const missed = missedLabel(status?.missedPeriods ?? detail?.missedPeriods ?? 0);

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
      {error && <div style={{ fontSize: 13, color: "var(--red)" }}>{error}</div>}

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

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 20 }}>
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
              <div style={{ fontSize: 13, whiteSpace: "pre-wrap", marginTop: 2, color: entry.voided ? "var(--label-3)" : "var(--label-1)" }}>{entry.body}</div>
              <Revisions entryId={entry.id} />
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
