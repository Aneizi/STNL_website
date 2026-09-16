"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import {
  addReportingUpdate,
  editReportingUpdate,
  loadTeamUpdates,
  saveCaptainContact,
  saveTeamContact,
} from "@/lib/hq/actions/reporting";
import type { ReportingEntryView, ReportingPeriod } from "@/lib/hq/reporting";
import type { SubmissionFocusView, TeamPeriodView, TeamReportingPanel } from "@/lib/hq/reporting-surface";
import {
  AUDIENCE_NOTES,
  MAX_CONTACT_LENGTH,
  deadlineLabel,
  missedLabel,
  mergeUpdatePages,
  NO_UPDATES_YET,
  periodRangeLabel,
  promptDismissKey,
  shouldPromptUpdate,
  statusLabel,
} from "@/lib/hq/reporting-view";
import styles from "./builder-shell.module.css";
import dashboard from "./team-reporting.module.css";
import { SubmissionFocus } from "./submission-focus";

/**
 * Shared team/Captain reporting UI. The server applies authorization and
 * sends only the permitted entries and public weekly status. Drafts retain
 * their original week/version across refreshes so changing either requires
 * the author's explicit choice.
 */

const MAX_BODY = 4000;

function ErrorText({ error }: { error: string }) {
  return error ? <p role="alert" className={styles.error}>{error}</p> : null;
}

/** "14 to 21 September", with the day the week is due beside it. */
function WeekLine({ period }: { period: { startDate: string; endDate: string } }) {
  return (
    <>
      {periodRangeLabel(period.startDate, period.endDate)}. Due by the end of {deadlineLabel(period.endDate)}.
    </>
  );
}

/** When an update was written, in the reader's own locale, with the edited note the plan asks for and nothing about what changed. */
function EntryWhen({ entry }: { entry: ReportingEntryView }) {
  return (
    <small>
      {entry.authorName}
      {entry.authorIsYou ? " (you)" : ""} on {entry.submittedAt.slice(0, 10)}
      {entry.edited ? ", edited since" : ""}
      {entry.late ? ", added after the week ended" : ""}
    </small>
  );
}

/**
 * One update, with an inline editor for its own author.
 *
 * A conflict keeps the draft exactly where it was and puts the saved version
 * beside it, so the person chooses rather than losing what they typed.
 */
function Entry({ entry, canMarkSensitive, onSaved }: { entry: ReportingEntryView; canMarkSensitive: boolean; onSaved: (entry: ReportingEntryView) => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(entry.body);
  const [draftVersion, setDraftVersion] = useState(entry.version);
  const [visibility, setVisibility] = useState(entry.visibility);
  const [conflict, setConflict] = useState<ReportingEntryView | null>(null);
  const [confirmAudience, setConfirmAudience] = useState(false);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  const expectedVersion = conflict ? conflict.version : draftVersion;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    start(async () => {
      setError("");
      let result;
      try { result = await editReportingUpdate({
        entryId: entry.id,
        body: draft,
        visibility,
        expectedVersion,
        confirmAudienceChange: confirmAudience || undefined,
      }); } catch {
        setError("The update could not be saved. Your text is still here. Please try again.");
        return;
      }
      if (result.ok) {
        onSaved(result.entry);
        setOpen(false);
        setConflict(null);
        setConfirmAudience(false);
        router.refresh();
        return;
      }
      setError(result.error);
      if (result.reason === "conflict") setConflict(result.current);
      if (result.reason === "audience_not_confirmed") setConfirmAudience(false);
    });
  };

  return (
    <div className={styles.card}>
      {entry.visibility === "sensitive" && <span className={styles.status}>Only you and Superteam NL admins</span>}
      <p style={{ whiteSpace: "pre-wrap", color: "#16130f" }}>{entry.body}</p>
      <EntryWhen entry={entry} />
      {entry.canEdit && !open && (
        <div className={styles.actions}>
          <button type="button" className={styles.textButton} onClick={() => { setDraft(entry.body); setDraftVersion(entry.version); setVisibility(entry.visibility); setOpen(true); }}>
            Edit this update
          </button>
        </div>
      )}
      {entry.canEdit && open && (
        <form className={styles.form} onSubmit={submit}>
          <label className={styles.field}>
            Your update
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={MAX_BODY} required rows={6} />
          </label>
          {canMarkSensitive && (
            <>
              <label className={styles.check}>
                Keep this note between you and Superteam NL admins
                <input
                  type="checkbox"
                  checked={visibility === "sensitive"}
                  onChange={(event) => { setVisibility(event.target.checked ? "sensitive" : "shared"); setConfirmAudience(false); }}
                />
              </label>
              <p>{visibility === "sensitive" ? AUDIENCE_NOTES.sensitive : AUDIENCE_NOTES.shared}</p>
            </>
          )}
          {entry.visibility === "sensitive" && visibility === "shared" && (
            <label className={styles.check}>
              I understand the team will be able to read this note from now on.
              <input type="checkbox" checked={confirmAudience} onChange={(event) => setConfirmAudience(event.target.checked)} />
            </label>
          )}
          {conflict && (
            <section className={styles.notice} aria-live="polite">
              <h3>Saved right now</h3>
              <p style={{ whiteSpace: "pre-wrap" }}>{conflict.body}</p>
              <EntryWhen entry={conflict} />
              <p>Your own text is still in the box above. Save again to replace what is saved now, or copy what you need out of it first.</p>
            </section>
          )}
          <ErrorText error={error} />
          <div className={styles.actions}>
            <button className={styles.button} disabled={pending}>{pending ? "Saving" : conflict ? "Save my text anyway" : "Save changes"}</button>
            <button type="button" className={styles.secondary} disabled={pending} onClick={() => { setOpen(false); setConflict(null); setError(""); }}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * The update composer.
 *
 * `expectedPeriodId` is the week the box was opened against. If that week has
 * ended by the time Save is pressed, the service refuses and names the week
 * that is open now; the composer then asks, and only a second, explicit press
 * moves the text into the new week.
 */
function Composer({
  projectId,
  hackathonId,
  period,
  canMarkSensitive,
  label,
  late = false,
  paused = false,
  onSaved,
  onDraftChange,
}: {
  projectId: string;
  hackathonId: number;
  period: TeamPeriodView | null;
  canMarkSensitive: boolean;
  label: string;
  late?: boolean;
  paused?: boolean;
  onSaved?: () => void;
  onDraftChange?: (hasDraft: boolean) => void;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [draftPeriodId, setDraftPeriodId] = useState<string | undefined>();
  const [visibility, setVisibility] = useState<"shared" | "sensitive">("shared");
  const [error, setError] = useState("");
  const [movedTo, setMovedTo] = useState<ReportingPeriod | null>(null);
  const [pending, start] = useTransition();

  const unavailable = paused || (!late && !period);

  const send = (targetPeriodId: string | undefined, asLate = late) =>
    start(async () => {
      setError("");
      if (paused) {
        setError("Reporting is paused. Your draft is still here for when reporting resumes.");
        return;
      }
      if (asLate && !targetPeriodId) {
        setError("Choose an earlier week for this update. Your text is still here.");
        return;
      }
      let result;
      try {
        result = await addReportingUpdate({ projectId, hackathonId, body, visibility, ...(asLate ? { periodId: targetPeriodId } : { expectedPeriodId: targetPeriodId }) });
      } catch {
        setError("The update could not be saved. Your text is still here. Please try again.");
        return;
      }
      if (result.ok) {
        setBody("");
        onDraftChange?.(false);
        setDraftPeriodId(undefined);
        setMovedTo(null);
        onSaved?.();
        router.refresh();
        return;
      }
      setError(result.error);
      if (result.reason === "period_changed") setMovedTo(result.currentPeriod);
    });

  // Keep the component mounted through deadline/pause refreshes. Empty
  // composers disappear; a started draft remains available to copy or save.
  if (unavailable && !body) return null;

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        send(late ? period?.periodId : draftPeriodId ?? period?.periodId);
      }}
    >
      <label className={styles.field}>
        {label}
        <textarea
          value={body}
          onChange={(event) => {
            if (!late && draftPeriodId === undefined) setDraftPeriodId(period?.periodId);
            setBody(event.target.value);
            onDraftChange?.(Boolean(event.target.value));
          }}
          maxLength={MAX_BODY}
          required
          rows={6}
          placeholder="What moved this week, what is in the way, what is next."
        />
      </label>
      {unavailable && (
        <p role="status">{paused
          ? "Reporting is paused. Your draft is still here; you can copy it or keep it until reporting resumes."
          : "There is no open reporting week. Your draft is still here; you can copy it or add it to its original week as a late update."}</p>
      )}
      {canMarkSensitive && (
        <>
          <label className={styles.check}>
            Keep this note between you and Superteam NL admins
            <input type="checkbox" checked={visibility === "sensitive"} onChange={(event) => setVisibility(event.target.checked ? "sensitive" : "shared")} />
          </label>
          <p>{visibility === "sensitive" ? AUDIENCE_NOTES.sensitive : AUDIENCE_NOTES.shared}</p>
        </>
      )}
      <ErrorText error={error} />
      {movedTo && !unavailable && (
        <section className={styles.notice} aria-live="polite">
          <h3>This is now week {movedTo.sequence}</h3>
          <p><WeekLine period={movedTo} /></p>
          <div className={styles.actions}>
            <button type="button" className={styles.button} disabled={pending} onClick={() => { setDraftPeriodId(movedTo.id); send(movedTo.id); }}>
              Save it to this week
            </button>
          </div>
        </section>
      )}
      {late && <p>This is a late update. It stays with the selected week and does not erase a missed week.</p>}
      {!movedTo && !unavailable && (
        <div className={styles.actions}>
          <button className={styles.button} disabled={pending || !body.trim()}>{pending ? "Saving" : late ? "Add late update" : "Add update"}</button>
        </div>
      )}
      {unavailable && (
        <div className={styles.actions}>
          {!paused && draftPeriodId && <button type="button" className={styles.button} disabled={pending || !body.trim()} onClick={() => send(draftPeriodId, true)}>Add as a late update to its original week</button>}
          <button type="button" className={styles.secondary} disabled={pending} onClick={() => { setBody(""); onDraftChange?.(false); setDraftPeriodId(undefined); setMovedTo(null); setError(""); }}>Discard draft</button>
        </div>
      )}
    </form>
  );
}

/** An authorized first page, with optional weekly filtering and older pages loaded on demand. */
function UpdateList({
  projectId,
  hackathonId,
  initial,
  initialCursor,
  weeks,
  canMarkSensitive,
}: {
  projectId: string;
  hackathonId: number;
  initial: ReportingEntryView[];
  initialCursor: string | null;
  /** Every stored week, newest first on screen, for the picker. Empty hides it. */
  weeks: TeamPeriodView[];
  canMarkSensitive: boolean;
}) {
  const [week, setWeek] = useState("");
  const [page, setPage] = useState({ projectId, hackathonId, initial, initialCursor, week, entries: initial, cursor: initialCursor, loading: false, error: "" });
  const requestId = useRef(0);

  // A refresh is authoritative: entries may have been voided or made
  // sensitive. Clear the old bodies before rendering children. A selected
  // week needs its own authorized read, rather than a filtered recent page.
  if (page.projectId !== projectId || page.hackathonId !== hackathonId || page.initial !== initial || page.initialCursor !== initialCursor || page.week !== week) {
    setPage({ projectId, hackathonId, initial, initialCursor, week, entries: week ? [] : initial, cursor: week ? null : initialCursor, loading: Boolean(week), error: "" });
  }

  const load = useCallback(async (from: string | null, replace: boolean) => {
    const request = ++requestId.current;
    const update = (change: (current: typeof page) => typeof page) => setPage((current) =>
      request === requestId.current && current.projectId === projectId && current.hackathonId === hackathonId && current.initial === initial && current.initialCursor === initialCursor && current.week === week ? change(current) : current,
    );
    try {
      const result = await loadTeamUpdates({ projectId, hackathonId, periodId: week || undefined, cursor: from ?? undefined });
      update((current) => {
        // Keep a just-saved newer version only when the authorized response
        // still includes that entry. Missing entries must stay removed.
        const retained = replace ? current.entries.filter((entry) => result.entries.some((fresh) => fresh.id === entry.id)) : current.entries;
        return { ...current, entries: mergeUpdatePages(retained, result.entries), cursor: result.nextCursor, loading: false, error: "" };
      });
    } catch {
      update((current) => ({ ...current, loading: false, error: "The updates could not be loaded. Please try again." }));
    }
  }, [projectId, hackathonId, initial, initialCursor, week]);

  useEffect(() => {
    if (week) void load(null, true);
    // Server Actions cannot be cancelled in flight; ignore their result on
    // a new selection, new server snapshot, or unmount.
    return () => { requestId.current += 1; };
  }, [week, load]);

  const requestPage = (from: string | null, replace: boolean) => {
    setPage((current) => ({ ...current, loading: true, error: "" }));
    void load(from, replace);
  };

  const savedEntry = (saved: ReportingEntryView) => {
    setPage((current) => current.projectId !== saved.projectId || (current.week && current.week !== saved.periodId)
      ? current
      : { ...current, entries: mergeUpdatePages(current.entries, [saved]), error: "" });
  };

  const ordered = [...weeks].sort((a, b) => b.periodSequence - a.periodSequence);

  return (
    <>
      {ordered.length > 1 && (
        <label className={styles.field}>
          Which week to show
          <select value={week} onChange={(event) => setWeek(event.target.value)}>
            <option value="">The most recent updates</option>
            {ordered.map((period) => (
              <option key={period.periodId} value={period.periodId}>
                Week {period.periodSequence}, {periodRangeLabel(period.startDate, period.endDate)}
              </option>
            ))}
          </select>
        </label>
      )}
      {page.entries.length === 0 && !page.loading && !page.error && <p>{NO_UPDATES_YET}</p>}
      {page.loading && <p role="status">Loading updates</p>}
      {page.entries.map((entry) => <Entry key={entry.id} entry={entry} canMarkSensitive={canMarkSensitive} onSaved={savedEntry} />)}
      <ErrorText error={page.error} />
      {page.error && (
        <button type="button" className={styles.secondary} disabled={page.loading} onClick={() => requestPage(page.cursor, page.entries.length === 0)}>Try again</button>
      )}
      {page.cursor && !page.error && (
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} disabled={page.loading} onClick={() => requestPage(page.cursor, false)}>
            {page.loading ? "Loading" : "Show older updates"}
          </button>
        </div>
      )}
    </>
  );
}

/** Keep the selected historical week stable when a refresh adds a newly closed week. */
function LateUpdateComposer({ projectId, hackathonId, weeks, canMarkSensitive, nowMs, paused = false }: {
  projectId: string; hackathonId: number; weeks: TeamPeriodView[]; canMarkSensitive: boolean; nowMs: number; paused?: boolean;
}) {
  const closed = weeks.filter((period) => Date.parse(period.endsAt) <= nowMs).sort((a, b) => b.periodSequence - a.periodSequence);
  const [selected, setSelected] = useState(closed[0]?.periodId ?? "");
  const [hasDraft, setHasDraft] = useState(false);
  if (!selected && closed[0]) setSelected(closed[0].periodId);
  const period = closed.find((week) => week.periodId === selected);
  if (!period || (paused && !hasDraft)) return null;
  return <details className={styles.details}>
    <summary>Add an update to an earlier week</summary>
    <label className={styles.field}>Week for this late update
      <select value={period.periodId} onChange={(event) => setSelected(event.target.value)}>
        {closed.map((week) => <option key={week.periodId} value={week.periodId}>Week {week.periodSequence}, {periodRangeLabel(week.startDate, week.endDate)}</option>)}
      </select>
    </label>
    <Composer projectId={projectId} hackathonId={hackathonId} period={period} canMarkSensitive={canMarkSensitive} label="Your late update" late paused={paused} onDraftChange={setHasDraft} />
  </details>;
}

/** Blocked browser storage simply means the prompt was never dismissed. */
function readDismissed(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** No subscription: a dismissal only ever happens in this tab, and the click below re-renders it directly. */
const noSubscribe = () => () => {};

/**
 * The server, and the client's hydrating render, both answer "not
 * dismissed", so the prompt is in the HTML the browser first receives rather
 * than appearing a moment later. React uses this snapshot for hydration and
 * then re-renders with the real one, so a dismissed prompt disappears
 * immediately afterwards with no mismatch.
 */
const notDismissedOnServer = () => false;

/**
 * The Monday and Tuesday prompt for one project and week.
 *
 * Inline and dismissible, never a popup: the plan asks for one prompt per
 * project and period and for no stack of blocking dialogs. A dismissal is
 * remembered in this browser only, keyed by project and week, so dismissing
 * one week never silences the next and dismissing one team never silences
 * another; the Add update action below stays whatever the prompt does.
 * Completion is what ends it for good, because completion is a fact about
 * the week rather than a preference.
 */
function Prompt({ projectId, period, teamName }: { projectId: string; period: TeamPeriodView; teamName: string }) {
  const key = promptDismissKey(projectId, period.periodId);
  // `useSyncExternalStore` is React's seam for reading a value that is not
  // React's own. Reading localStorage during render, or setting state from an
  // effect, would be a hydration mismatch and a cascading render
  // respectively; this is neither.
  const stored = useSyncExternalStore(noSubscribe, () => readDismissed(key), notDismissedOnServer);
  const [dismissed, setDismissed] = useState(false);

  if (stored || dismissed) return null;
  return (
    <section className={styles.notice} role="status" aria-label={`Weekly update needed for ${teamName}`}>
      <h3>This week still needs an update</h3>
      <p>{teamName} has nothing recorded for {periodRangeLabel(period.startDate, period.endDate)}. Due by the end of {deadlineLabel(period.endDate)}.</p>
      <div className={styles.actions}>
        <a className={styles.button} href={`#update-${projectId}`}>Add this week&apos;s update</a>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => {
            try {
              window.localStorage.setItem(key, "1");
            } catch {
              // A browser with site data turned off simply gets the prompt
              // again next time; nothing else depends on this.
            }
            setDismissed(true);
          }}
        >
          Not now
        </button>
      </div>
    </section>
  );
}

/** A one-line contact someone sets for themselves or for their team. Saving it is the approval. */
function ContactField({
  label,
  help,
  initial,
  save,
}: {
  label: string;
  help: string;
  initial: string | null;
  save: (value: string) => Promise<{ ok: true; contact: string | null } | { ok: false; error: string }>;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initial ?? "");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        start(async () => {
          setError("");
          setSaved(false);
          let result;
          try { result = await save(value); } catch {
            setError("The contact could not be saved. Please try again.");
            return;
          }
          if (result.ok) {
            setSaved(true);
            router.refresh();
          } else setError(result.error);
        });
      }}
    >
      <label className={styles.field}>
        {label}
        <input value={value} onChange={(event) => setValue(event.target.value)} maxLength={MAX_CONTACT_LENGTH} placeholder="Telegram handle, email, or however you prefer" />
      </label>
      <p>{help}</p>
      <ErrorText error={error} />
      {saved && <p role="status" className={styles.success}>Saved.</p>}
      <div className={styles.actions}>
        <button className={styles.secondary} disabled={pending}>{pending ? "Saving" : "Save contact"}</button>
      </div>
    </form>
  );
}

/** The week's headline: Updated or Not updated, the dates, and any weeks already missed. */
function WeekSummary({ current, missedPeriods, paused }: { current: TeamPeriodView | null; missedPeriods: number; paused: boolean }) {
  const missed = missedLabel(missedPeriods);
  if (paused) {
    return (
      <>
        <span className={styles.status}>Reporting paused</span>
        <p>Superteam NL paused weekly updates for this team. Nothing is due, and the weeks already recorded are unchanged.</p>
      </>
    );
  }
  if (!current) {
    return (
      <>
        <span className={styles.status}>No open week</span>
        <p>There is no reporting week open right now.{missed ? ` ${missed} so far.` : ""}</p>
      </>
    );
  }
  return (
    <>
      <span className={styles.status}>{statusLabel(current.completed)}</span>
      <p><WeekLine period={current} />{missed ? ` ${missed} earlier in this hackathon.` : ""}</p>
    </>
  );
}

export type TeamReportingProps = {
  /** Exactly what `teamReportingPanel` composed: the team-facing week shape, never the service's own. */
  panel: TeamReportingPanel;
  teamName: string;
  /** Whether this viewer is the team lead, who sets the team's preferred contact. */
  isLead: boolean;
  /** The request instant, passed from the server so the prompt's day is the campaign's, not the browser's clock. */
  nowMs: number;
  variant?: "default" | "dashboard";
};

/** Disclosure keeps its children mounted, so hiding a form never discards a draft. */
function ReportingDisclosure({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className={dashboard.disclosure}>
      <button className={dashboard.disclosureButton} type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <span>{title}</span>
        <span className={dashboard.chevron} aria-hidden="true" />
      </button>
      <div id={id} className={dashboard.disclosureContent} hidden={!open}>{children}</div>
    </section>
  );
}

function DashboardTeamReporting({ panel, isLead, nowMs }: TeamReportingProps) {
  const [writing, setWriting] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  const [saved, setSaved] = useState(false);
  const writeButton = useRef<HTMLButtonElement>(null);
  const focus = panel.submissionFocus;
  const current = panel.current;
  const canWrite = panel.enrolled && Boolean(current) && !panel.paused;
  const titleId = `reporting-title-${panel.projectId}`;

  return (
    <div className={dashboard.dashboard}>
      {focus?.open && <SubmissionFocus focus={focus} variant="dashboard" />}
      <section className={dashboard.week} aria-labelledby={titleId}>
        <div className={dashboard.sectionHeader}>
          <div>
            <h2 id={titleId}>{focus?.open ? "Team update" : "This week"}</h2>
            <p className={dashboard.meta}>
              {!panel.enrolled ? "Weekly updates are not enabled." : panel.paused ? "Updates paused" : !current ? "No update due" : current.completed ? "Complete" : `Due ${deadlineLabel(current.endDate)}`}
            </p>
          </div>
          {(canWrite || writing || hasDraft) && (
            <button
              ref={writeButton}
              type="button"
              className={focus?.open || current?.completed || writing ? dashboard.secondary : dashboard.primary}
              aria-expanded={writing}
              aria-controls={`update-${panel.projectId}`}
              onClick={() => { setWriting(!writing); setSaved(false); }}
            >
              {writing ? "Hide update" : hasDraft ? "Resume draft" : "Write update"}
            </button>
          )}
        </div>
        {saved && <p className={dashboard.saved} role="status">Update saved.</p>}
        {/* A deadline or pause must not unmount a draft while it is being written. */}
        <div id={`update-${panel.projectId}`} className={dashboard.composer} hidden={!writing}>
          <Composer
            projectId={panel.projectId}
            hackathonId={panel.hackathonId}
            period={current}
            canMarkSensitive={false}
            label="Your update"
            paused={panel.paused || !panel.enrolled}
            onDraftChange={setHasDraft}
            onSaved={() => { setWriting(false); setSaved(true); writeButton.current?.focus(); }}
          />
        </div>
      </section>
      {panel.enrolled && (
        <>
          <ReportingDisclosure id={`history-${panel.projectId}`} title="Update history">
            {panel.missedPeriods > 0 && <p className={dashboard.meta}>{missedLabel(panel.missedPeriods)}</p>}
            <UpdateList
              projectId={panel.projectId}
              hackathonId={panel.hackathonId}
              initial={panel.entries}
              initialCursor={panel.nextCursor}
              weeks={panel.history}
              canMarkSensitive={false}
            />
            <LateUpdateComposer projectId={panel.projectId} hackathonId={panel.hackathonId} weeks={panel.history} canMarkSensitive={false} nowMs={nowMs} paused={panel.paused} />
          </ReportingDisclosure>
          {focus && !focus.open && (
            <ReportingDisclosure id={`submission-history-${panel.projectId}`} title="Submission">
              <SubmissionFocus focus={focus} variant="dashboard" />
            </ReportingDisclosure>
          )}
          {isLead && (
            <ReportingDisclosure id={`team-contact-${panel.projectId}`} title="Contact preference">
              <ContactField
                label="Team contact"
                help="Shared with your Captain and Superteam NL."
                initial={panel.teamContact}
                save={(contact) => saveTeamContact({ projectId: panel.projectId, hackathonId: panel.hackathonId, contact })}
              />
            </ReportingDisclosure>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The team page's weekly reporting section. The Captain line is the page's,
 * not this section's: a team has a Captain whether or not it is in weekly
 * reporting yet, so hiding it behind reporting would lose it.
 */
export function TeamReporting({ panel, teamName, isLead, nowMs, variant = "default" }: TeamReportingProps) {
  if (variant === "dashboard") return <DashboardTeamReporting panel={panel} teamName={teamName} isLead={isLead} nowMs={nowMs} />;
  const prompt = shouldPromptUpdate({ current: panel.current, atMs: nowMs, timezone: panel.timezone, paused: panel.paused });
  const focus = panel.submissionFocus;
  return (
    <section aria-labelledby="team-reporting-title">
      {/* The final period leads with the submission, per the plan: in it,
          what matters is the actual Colosseum submission rather than another
          written update. Outside it, and after it, the panel sits below the
          week instead, because the week is what is live. */}
      {focus?.open && <SubmissionFocus focus={focus} />}
      <h2 id="team-reporting-title">{focus?.open ? "This period" : "This week"}</h2>
      {!panel.enrolled ? (
        <p>This team is not in weekly updates yet. Ask Superteam NL to add it.</p>
      ) : (
        <>
          <WeekSummary current={panel.current} missedPeriods={panel.missedPeriods} paused={panel.paused} />
          {prompt && panel.current && <Prompt projectId={panel.projectId} period={panel.current} teamName={teamName} />}
          <div id={`update-${panel.projectId}`}>
              <Composer
                projectId={panel.projectId}
                hackathonId={panel.hackathonId}
                period={panel.current}
                canMarkSensitive={false}
                label="Your update for this week"
                paused={panel.paused}
              />
          </div>
          <h3>Updates</h3>
          <UpdateList
            projectId={panel.projectId}
            hackathonId={panel.hackathonId}
            initial={panel.entries}
            initialCursor={panel.nextCursor}
            weeks={panel.history}
            canMarkSensitive={false}
          />
          <LateUpdateComposer projectId={panel.projectId} hackathonId={panel.hackathonId} weeks={panel.history} canMarkSensitive={false} nowMs={nowMs} />
          {/* After the period ends the submission detail stays, which is the
              plan's "retain history and submission details"; it simply stops
              being the first thing on the page. */}
          {focus && !focus.open && <SubmissionFocus focus={focus} />}
          {isLead && (
            <ContactField
              label="How your Captain should reach the team"
              help="Shared with your Captain and with Superteam NL admins. Leave it empty to share nothing."
              initial={panel.teamContact}
              save={(contact) => saveTeamContact({ projectId: panel.projectId, hackathonId: panel.hackathonId, contact })}
            />
          )}
        </>
      )}
    </section>
  );
}

export type CaptainCardProps = {
  projectId: string;
  projectName: string;
  hackathonId: number;
  current: TeamPeriodView | null;
  /** Every stored week, for the card's week picker. */
  weeks: TeamPeriodView[];
  missedPeriods: number;
  paused: boolean;
  teamContact: string | null;
  /** This Captain's readable updates on the project, newest first, and where the next page starts. */
  entries: ReportingEntryView[];
  nextCursor: string | null;
  timezone: string;
  nowMs: number;
  /** The team's final period, once the edition has one. Null for a project with no Colosseum source behind it. */
  submissionFocus?: SubmissionFocusView | null;
  /** The imported detail, when the project has an imported team behind it. */
  children?: React.ReactNode;
};

/** One assigned project on the Captain page: its week first, then whatever team detail exists. */
export function CaptainProjectCard(props: CaptainCardProps) {
  const prompt = shouldPromptUpdate({ current: props.current, atMs: props.nowMs, timezone: props.timezone, paused: props.paused });
  const focus = props.submissionFocus ?? null;
  return (
    <section className={styles.card} aria-label={props.projectName}>
      <h2>{props.projectName}</h2>
      {/* The same panel the team sees, from the same server composition, so a
          Captain and their team can never read a different submission state
          off two screens. */}
      {focus && <SubmissionFocus focus={focus} />}
      <WeekSummary current={props.current} missedPeriods={props.missedPeriods} paused={props.paused} />
      {prompt && props.current && <Prompt projectId={props.projectId} period={props.current} teamName={props.projectName} />}
      <p>{props.teamContact ? `Team contact: ${props.teamContact}` : "This team has not shared a contact yet."}</p>
      <h3>Updates</h3>
      <UpdateList
        projectId={props.projectId}
        hackathonId={props.hackathonId}
        initial={props.entries}
        initialCursor={props.nextCursor}
        weeks={props.weeks}
        canMarkSensitive
      />
      <LateUpdateComposer projectId={props.projectId} hackathonId={props.hackathonId} weeks={props.weeks} canMarkSensitive nowMs={props.nowMs} />
      <div id={`update-${props.projectId}`}>
          <Composer
            projectId={props.projectId}
            hackathonId={props.hackathonId}
            period={props.current}
            canMarkSensitive
            label={`Your note on ${props.projectName}`}
            paused={props.paused}
          />
      </div>
      {props.children}
    </section>
  );
}

/** The Captain's own approved contact, offered once above their assignments. */
export function CaptainContact({ initial }: { initial: string | null }) {
  return (
    <ContactField
      label="How your teams should reach you"
      help="Shared with the teams you are assigned to and with Superteam NL admins. Leave it empty to share nothing."
      initial={initial}
      save={(contact) => saveCaptainContact({ contact })}
    />
  );
}
