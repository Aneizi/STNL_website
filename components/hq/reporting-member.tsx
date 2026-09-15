"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, useTransition } from "react";
import {
  addReportingUpdate,
  editReportingUpdate,
  loadTeamUpdates,
  saveCaptainContact,
  saveTeamContact,
} from "@/lib/hq/actions/reporting";
import type { ReportingEntryView, ReportingPeriod } from "@/lib/hq/reporting";
import type { TeamPeriodView, TeamReportingPanel } from "@/lib/hq/reporting-surface";
import {
  AUDIENCE_NOTES,
  MAX_CONTACT_LENGTH,
  deadlineLabel,
  missedLabel,
  NO_UPDATES_YET,
  periodRangeLabel,
  promptDismissKey,
  shouldPromptUpdate,
  statusLabel,
} from "@/lib/hq/reporting-view";
import styles from "./builder-shell.module.css";

/**
 * The member reporting interface: the week, the updates, the composer and
 * the two contacts, shared by the team page and the Captain page.
 *
 * Every rule lives on the server. This file decides wording and layout, and
 * it treats two service refusals as real answers rather than errors, which
 * is the whole reason they carry data:
 *
 * - A new week starting mid-draft comes back as `period_changed` with the
 *   week that is open now. The text stays in the box and the person is asked
 *   which week it belongs to, instead of the save silently landing in a
 *   different week or the text being lost.
 * - An edit that lost a race comes back as `conflict` with the version that
 *   is saved now. Both are shown together, the unsaved text is never
 *   discarded, and saving again is an explicit choice.
 *
 * No sensitive note the viewer did not write ever reaches this file, and
 * nothing about one does either. The audience is applied in SQL, and the
 * weeks arrive as `TeamPeriodView` rather than the service's own
 * `PeriodStatus`, which carries an entry count, a latest-entry timestamp and
 * the completion's basis. A client component is handed its props whether it
 * renders them or not, so a field this file does not use is still a field the
 * browser receives; the only way not to send one is not to put it in the
 * shape.
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
function Entry({ entry, canMarkSensitive }: { entry: ReportingEntryView; canMarkSensitive: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(entry.body);
  const [visibility, setVisibility] = useState(entry.visibility);
  const [conflict, setConflict] = useState<ReportingEntryView | null>(null);
  const [confirmAudience, setConfirmAudience] = useState(false);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  const expectedVersion = conflict ? conflict.version : entry.version;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    start(async () => {
      setError("");
      const result = await editReportingUpdate({
        entryId: entry.id,
        body: draft,
        visibility,
        expectedVersion,
        confirmAudienceChange: confirmAudience || undefined,
      });
      if (result.ok) {
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
          <button type="button" className={styles.textButton} onClick={() => { setDraft(entry.body); setVisibility(entry.visibility); setOpen(true); }}>
            Edit this update
          </button>
        </div>
      )}
      {open && (
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
}: {
  projectId: string;
  hackathonId: number;
  period: TeamPeriodView | null;
  canMarkSensitive: boolean;
  label: string;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<"shared" | "sensitive">("shared");
  const [error, setError] = useState("");
  const [movedTo, setMovedTo] = useState<ReportingPeriod | null>(null);
  const [pending, start] = useTransition();

  const send = (expectedPeriodId: string | undefined) =>
    start(async () => {
      setError("");
      const result = await addReportingUpdate({ projectId, hackathonId, body, visibility, expectedPeriodId });
      if (result.ok) {
        setBody("");
        setMovedTo(null);
        router.refresh();
        return;
      }
      setError(result.error);
      if (result.reason === "period_changed") setMovedTo(result.currentPeriod);
    });

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        send(period?.periodId);
      }}
    >
      <label className={styles.field}>
        {label}
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          maxLength={MAX_BODY}
          required
          rows={6}
          placeholder="What moved this week, what is in the way, what is next."
        />
      </label>
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
      {movedTo && (
        <section className={styles.notice} aria-live="polite">
          <h3>This is now week {movedTo.sequence}</h3>
          <p><WeekLine period={movedTo} /></p>
          <div className={styles.actions}>
            <button type="button" className={styles.button} disabled={pending} onClick={() => send(movedTo.id)}>
              Save it to this week
            </button>
          </div>
        </section>
      )}
      {!movedTo && (
        <div className={styles.actions}>
          <button className={styles.button} disabled={pending || !body.trim()}>{pending ? "Saving" : "Add update"}</button>
        </div>
      )}
    </form>
  );
}

/**
 * A project's updates: the first page from the server, then every later page
 * on request, and a week picker over the stored weeks.
 *
 * The list is what an author edits through, so a first page with a sentence
 * saying the rest exist was also a limit on editing: the moment a teammate
 * posted a newer update, an earlier one had no control on the screen at all.
 * Both continuations go through `loadTeamUpdates`, which is the same
 * audience-applying service read the page did, so a later page can never
 * contain something the first page would have withheld.
 *
 * Choosing a week reloads rather than filters what is already here: the
 * entries in hand are only the newest page, so filtering them would answer
 * "no updates" for a week whose updates simply had not been fetched.
 */
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
  const [entries, setEntries] = useState(initial);
  const [cursor, setCursor] = useState(initialCursor);
  const [week, setWeek] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  const load = (periodId: string, from: string | null, replace: boolean) =>
    start(async () => {
      setError("");
      const page = await loadTeamUpdates({ projectId, hackathonId, periodId: periodId || undefined, cursor: from ?? undefined });
      setEntries(replace ? page.entries : [...entries, ...page.entries]);
      setCursor(page.nextCursor);
    });

  const chooseWeek = (value: string) => {
    setWeek(value);
    if (!value) {
      setEntries(initial);
      setCursor(initialCursor);
      return;
    }
    load(value, null, true);
  };

  const ordered = [...weeks].sort((a, b) => b.periodSequence - a.periodSequence);

  return (
    <>
      {ordered.length > 1 && (
        <label className={styles.field}>
          Which week to show
          <select value={week} onChange={(event) => chooseWeek(event.target.value)} disabled={pending}>
            <option value="">The most recent updates</option>
            {ordered.map((period) => (
              <option key={period.periodId} value={period.periodId}>
                Week {period.periodSequence}, {periodRangeLabel(period.startDate, period.endDate)}
              </option>
            ))}
          </select>
        </label>
      )}
      {entries.length === 0 && !pending && <p>{NO_UPDATES_YET}</p>}
      {entries.map((entry) => <Entry key={entry.id} entry={entry} canMarkSensitive={canMarkSensitive} />)}
      <ErrorText error={error} />
      {cursor && (
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} disabled={pending} onClick={() => load(week, cursor, false)}>
            {pending ? "Loading" : "Show older updates"}
          </button>
        </div>
      )}
    </>
  );
}

/** localStorage, read defensively: a private window or blocked site data simply means the prompt was never dismissed. */
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
          const result = await save(value);
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
};

/**
 * The team page's weekly reporting section. The Captain line is the page's,
 * not this section's: a team has a Captain whether or not it is in weekly
 * reporting yet, so hiding it behind reporting would lose it.
 */
export function TeamReporting({ panel, teamName, isLead, nowMs }: TeamReportingProps) {
  const prompt = shouldPromptUpdate({ current: panel.current, atMs: nowMs, timezone: panel.timezone, paused: panel.paused });
  return (
    <section aria-labelledby="team-reporting-title">
      <h2 id="team-reporting-title">This week</h2>
      {!panel.enrolled ? (
        <p>This team is not in weekly updates yet. Ask Superteam NL to add it.</p>
      ) : (
        <>
          <WeekSummary current={panel.current} missedPeriods={panel.missedPeriods} paused={panel.paused} />
          {prompt && panel.current && <Prompt projectId={panel.projectId} period={panel.current} teamName={teamName} />}
          {!panel.paused && panel.current && (
            <div id={`update-${panel.projectId}`}>
              <Composer
                projectId={panel.projectId}
                hackathonId={panel.hackathonId}
                period={panel.current}
                canMarkSensitive={false}
                label="Your update for this week"
              />
            </div>
          )}
          <h3>Updates</h3>
          <UpdateList
            projectId={panel.projectId}
            hackathonId={panel.hackathonId}
            initial={panel.entries}
            initialCursor={panel.nextCursor}
            weeks={panel.history}
            canMarkSensitive={false}
          />
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
  /** The imported detail, when the project has an imported team behind it. */
  children?: React.ReactNode;
};

/** One assigned project on the Captain page: its week first, then whatever team detail exists. */
export function CaptainProjectCard(props: CaptainCardProps) {
  const prompt = shouldPromptUpdate({ current: props.current, atMs: props.nowMs, timezone: props.timezone, paused: props.paused });
  return (
    <section className={styles.card} aria-label={props.projectName}>
      <h2>{props.projectName}</h2>
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
      {!props.paused && props.current && (
        <div id={`update-${props.projectId}`}>
          <Composer
            projectId={props.projectId}
            hackathonId={props.hackathonId}
            period={props.current}
            canMarkSensitive
            label={`Your note on ${props.projectName}`}
          />
        </div>
      )}
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
