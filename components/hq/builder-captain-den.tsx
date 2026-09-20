"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { IconArrowLeft } from "symbols-react";
import { IconLockFill } from "@/components/hq/icons/IconLockFill";
import { addReportingUpdate, loadTeamUpdates, loadMemberColosseumUpdates } from "@/lib/hq/actions/reporting";
import { ColosseumUpdates } from "./colosseum-updates";
import type { ReportingEntryView } from "@/lib/hq/reporting";
import { captainMetaLabel, dueLine, mergeUpdatePages, NOTE_ADDED, PRIVATE_TOOLTIP, telegramContactHref, weekOfLabel } from "@/lib/hq/reporting-view";
import { ReportingEntryCard } from "./reporting-entry-card";
import { validUpdateBody } from "@/lib/hq/reporting-body";
import { UpdateTextarea } from "./update-textarea";
import styles from "./builder-captain-den.module.css";


/**
 * One of the Captain's assigned teams, as the page serializes it: what the
 * Den renders and nothing wider. No service row, no account id, no project
 * description; the roster carries names and Colosseum usernames only.
 */
export type CaptainDenTeam = {
  projectId: string;
  hackathonId: number;
  name: string;
  paused: boolean;
  /** The open week, or null outside the campaign and for a project not in reporting yet. */
  current: { periodId: string; endsAt: string; completed: boolean } | null;
  /** The imported roster; empty for a project an admin created in the CRM. */
  roster: { name: string; username: string; joined: boolean }[];
  leadUsername: string | null;
  /** The project on Colosseum, or null when it was never imported. */
  projectUrl: string | null;
  /** Free text the team lead typed. Linked only when it is shaped like a Telegram handle. */
  teamContact: string | null;
  /** The notes and updates this Captain may read, newest first: the first page. */
  entries: ReportingEntryView[];
  nextCursor: string | null;
};

export type BuilderCaptainDenProps = {
  /** In the page's order: the teams still needing this week's update first. */
  teams: CaptainDenTeam[];
  /** Where the edition is, or null outside the campaign. */
  week: { sequence: number; total: number } | null;
  timezone: string;
  /** The Captain's own handle, read only here; it changes with their Telegram account. */
  contact: string | null;
};

/** The words for the two states the design does not draw, in the status kicker's quiet colour. */
const NO_OPEN_WEEK = "No open week";
const REPORTING_PAUSED = "Reporting paused";
const STATUS_DONE = "Team updated this week. No note needed";
const NO_TEAMS = "No teams assigned yet. Reach out to an admin to link your teams to you.";
const NOTE_FAILED = "The note could not be saved. Your text is kept. Try again.";
const OLDER_FAILED = "Older notes could not be loaded. Try again.";

/** What the Captain has typed for one team, kept across switching teams and after a failed save. */
type Draft = { body: string; periodId: string | null; priv: boolean; saved: boolean; error: string };
const EMPTY_DRAFT: Draft = { body: "", periodId: null, priv: false, saved: false, error: "" };

/**
 * What this browser has added to one team's list beyond the page's first
 * page: notes saved here before the refresh lands, and older pages fetched
 * on request. `cursor` is undefined until an older page was loaded, so the
 * server's cursor stays in charge until then.
 */
type Loaded = { extra: ReportingEntryView[]; cursor?: string | null; loading: boolean; error: string };
const EMPTY_LOADED: Loaded = { extra: [], loading: false, error: "" };

type Status = { text: string; tone: "due" | "done" | "quiet" };

function statusOf(team: CaptainDenTeam, timezone: string): Status {
  if (team.paused) return { text: REPORTING_PAUSED, tone: "quiet" };
  if (!team.current) return { text: NO_OPEN_WEEK, tone: "quiet" };
  if (team.current.completed) return { text: STATUS_DONE, tone: "done" };
  return { text: `Team not updated. ${dueLine(team.current.endsAt, timezone)}`, tone: "due" };
}

/** The aside's marker beside a team: the orange dot, the word Updated, or nothing while the team owes nothing. */
function markerOf(team: CaptainDenTeam): "pending" | "updated" | null {
  if (team.paused || !team.current) return null;
  return team.current.completed ? "updated" : "pending";
}

const STATUS_CLASS: Record<Status["tone"], string> = {
  due: `${styles.status} ${styles.statusDue}`,
  done: `${styles.status} ${styles.statusDone}`,
  quiet: styles.status,
};

/**
 * The Captains' Den: the Captain's teams down the ink aside, and the selected
 * team's builders, contact, note form and earlier notes in the main column.
 *
 * Selection is client state and never navigates. Every team keeps its own
 * draft, its Keep private choice and its "Note added." flag while another is
 * selected. A saved note is shown at once and the router refreshed so the
 * server's page catches up; the two are merged by id, so the refresh never
 * drops or doubles it. Nothing here decides completion: a note is a note, and
 * the status kicker and the aside marker only ever say what the server said.
 */
export function BuilderCaptainDen({ teams, week, timezone, contact }: BuilderCaptainDenProps) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tipOpen, setTipOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [pending, start] = useTransition();

  const team = teams.find((candidate) => candidate.projectId === selectedId) ?? teams[0] ?? null;
  const draft = team ? drafts[team.projectId] ?? EMPTY_DRAFT : EMPTY_DRAFT;
  const page = team ? loaded[team.projectId] ?? EMPTY_LOADED : EMPTY_LOADED;
  const entries = team ? mergeUpdatePages(team.entries, page.extra) : [];
  const cursor = team ? (page.cursor === undefined ? team.nextCursor : page.cursor) : null;

  const patchDraft = (projectId: string, change: Partial<Draft>) =>
    setDrafts((current) => ({ ...current, [projectId]: { ...(current[projectId] ?? EMPTY_DRAFT), ...change } }));
  const patchLoaded = (projectId: string, change: (current: Loaded) => Loaded) =>
    setLoaded((current) => ({ ...current, [projectId]: change(current[projectId] ?? EMPTY_LOADED) }));
  const addEntry = (projectId: string, entry: ReportingEntryView) =>
    patchLoaded(projectId, (current) => ({ ...current, extra: mergeUpdatePages(current.extra, [entry]) }));

  const canNote = team !== null && !team.paused && team.current !== null;
  const invalid = !validUpdateBody(draft.body);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!team?.current || invalid) return;
    const { projectId, hackathonId } = team;
    const periodId = draft.periodId ?? team.current.periodId;
    const { body, priv } = draft;
    start(async () => {
      patchDraft(projectId, { error: "" });
      let result;
      try {
        // Bound to the week the form was written against, so a save that
        // crosses midnight is refused with its own message rather than
        // silently moved into the next week.
        result = await addReportingUpdate({ projectId, hackathonId, body, visibility: priv ? "sensitive" : "shared", expectedPeriodId: periodId });
      } catch {
        patchDraft(projectId, { error: NOTE_FAILED });
        return;
      }
      if (result.ok) {
        addEntry(projectId, result.entry);
        patchDraft(projectId, { body: "", periodId: null, saved: true });
        router.refresh();
        return;
      }
      patchDraft(projectId, { error: result.error });
      if (result.reason === "period_changed" && result.currentPeriod) router.refresh();
    });
  };

  const loadOlder = () => {
    if (!team || !cursor) return;
    const { projectId, hackathonId } = team;
    patchLoaded(projectId, (current) => ({ ...current, loading: true, error: "" }));
    void (async () => {
      try {
        const result = await loadTeamUpdates({ projectId, hackathonId, cursor });
        patchLoaded(projectId, (current) => ({ ...current, extra: mergeUpdatePages(current.extra, result.entries), cursor: result.nextCursor, loading: false }));
      } catch {
        patchLoaded(projectId, (current) => ({ ...current, loading: false, error: OLDER_FAILED }));
      }
    })();
  };

  const status = team ? statusOf(team, timezone) : null;
  const contactHref = team ? telegramContactHref(team.teamContact) : null;
  const lastUpdate = entries.find((entry) => entry.visibility !== "sensitive" && !entry.authorIsYou);

  return (
    <div className={styles.shell}>
      <aside className={styles.aside} aria-label="Your teams">
        <Link className={styles.home} href="/hq/dashboard">
          <IconArrowLeft width={16} height={16} fill="currentColor" aria-hidden="true" />
          Home
        </Link>
        <div>
          <h1 className={styles.title}>Captains&apos;<br />Den</h1>
          {week && <p className={styles.week}>{weekOfLabel(week.sequence, week.total)}</p>}
        </div>
        <div>
          <p className={styles.asideKicker}>Your teams</p>
          <div className={styles.teams}>
            {teams.map((candidate) => {
              const marker = markerOf(candidate);
              return (
                <button
                  key={candidate.projectId}
                  type="button"
                  className={styles.team}
                  aria-pressed={candidate.projectId === team?.projectId}
                  onClick={() => setSelectedId(candidate.projectId)}
                >
                  <span className={styles.teamName}>{candidate.name}</span>
                  {marker === "updated" && <span className={styles.updated}>Updated</span>}
                  {marker === "pending" && <span className={styles.dot} role="img" aria-label="Not updated" />}
                </button>
              );
            })}
          </div>
        </div>
        <div className={styles.contact}>
          <p className={styles.contactKicker}>Your contact</p>
          {contact ? <p className={styles.handle}>{contact}</p> : <p className={styles.handleMissing}>Not shared yet.</p>}
        </div>
      </aside>
      <div className={styles.main}>
        {!team && <p className={styles.empty}>{NO_TEAMS}</p>}
        {team && status && (
          <>
            <p className={STATUS_CLASS[status.tone]}>{status.text}</p>
            <h2 className={styles.teamTitle}>{team.name}</h2>
            <div className={styles.facts}>
              <div>
                <p className={styles.kicker}>Builders</p>
                <ul className={styles.roster}>
                  {team.roster.map((member) => {
                    const lead = team.leadUsername !== null && member.username === team.leadUsername;
                    return (
                      <li className={styles.member} key={member.username || member.name}>
                        <span className={styles.memberName}>{member.name}</span>
                        <span className={lead ? `${styles.tag} ${styles.tagLead}` : styles.tag}>{lead ? "Lead" : member.joined ? "" : "Not joined"}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div>
                <p className={styles.kicker}>Contact</p>
                {contactHref && <a className={styles.contactLink} href={contactHref} target="_blank" rel="noopener noreferrer">{team.teamContact}</a>}
                {!contactHref && team.teamContact && <p className={styles.contactText}>{team.teamContact}</p>}
                {!team.teamContact && <p className={styles.muted}>Not shared yet.</p>}
                <p className={styles.lastUpdate}>{lastUpdate ? `Last update: ${captainMetaLabel(lastUpdate, timezone)}.` : "No update from the team this week."}</p>
                {team.projectUrl && <a className={styles.colosseum} href={team.projectUrl} target="_blank" rel="noopener noreferrer">View on Colosseum</a>}
              </div>
            </div>
            {canNote && (
              <>
                <p className={styles.kicker}>{team.current?.completed ? "Your note (optional)" : "Your note"}</p>
                <form className={styles.form} onSubmit={submit} aria-busy={pending}>
                  <UpdateTextarea
                    className={styles.textarea}
                    value={draft.body}
                    onChange={(event) => patchDraft(team.projectId, {
                      body: event.target.value,
                      periodId: draft.body.trim() ? draft.periodId : team.current!.periodId,
                      saved: false,
                    })}
                    rows={5}
                    aria-label="Your note"
                    placeholder="What you saw, what you told them, what to watch."
                  />
                  {draft.body.trim() && draft.periodId !== null && draft.periodId !== team.current?.periodId && <div>
                    <p role="alert" className={styles.alert}>The week changed while you were writing. Your draft is kept.</p>
                    <button type="button" className={styles.older} onClick={() => patchDraft(team.projectId, { periodId: team.current!.periodId, error: "" })}>Use current week</button>
                  </div>}
                  <div className={styles.row}>
                    <button type="submit" className={styles.add} disabled={invalid || pending}>Add note</button>
                    <span
                      className={styles.privWrap}
                      onMouseEnter={() => setTipOpen(true)}
                      onMouseLeave={() => setTipOpen(false)}
                      onFocus={() => setTipOpen(true)}
                      onBlur={() => setTipOpen(false)}
                    >
                      <label className={styles.privLabel}>
                        <input
                          type="checkbox"
                          className={styles.privBox}
                          checked={draft.priv}
                          onChange={(event) => patchDraft(team.projectId, { priv: event.target.checked })}
                          aria-describedby="priv-tip"
                        />
                        Keep private
                      </label>
                      <span id="priv-tip" role="tooltip" className={styles.tooltip} hidden={!tipOpen}>{PRIVATE_TOOLTIP}</span>
                    </span>
                    {draft.saved && <span role="status" className={styles.saved}>{NOTE_ADDED}</span>}
                    {draft.error && <p role="alert" className={styles.alert}>{draft.error}</p>}
                  </div>
                </form>
              </>
            )}
            {entries.length > 0 && (
              <section className={styles.earlier} aria-label="Earlier notes">
                <h3 className={styles.earlierTitle}>Earlier</h3>
                <div className={styles.entries}>
                  {entries.map((entry) => (
                    <ReportingEntryCard
                      key={entry.id}
                      entry={entry}
                      meta={captainMetaLabel(entry, timezone)}
                      canEdit={false}
                      tag={entry.visibility === "sensitive" ? (
                        <span className={styles.privateTag} title={PRIVATE_TOOLTIP}>
                          <IconLockFill width={12} height={16} className={styles.lock} />
                          Private
                        </span>
                      ) : undefined}
                      onSaved={(saved) => addEntry(team.projectId, saved)}
                    />
                  ))}
                </div>
                {page.error && <p role="alert" className={styles.olderAlert}>{page.error}</p>}
                {cursor && <button type="button" className={styles.older} disabled={page.loading} onClick={loadOlder}>Show older notes</button>}
              </section>
            )}
            <ColosseumUpdates key={team.projectId} projectId={team.projectId} hackathonId={team.hackathonId} timezone={timezone} loadUpdates={loadMemberColosseumUpdates}/>
          </>
        )}
      </div>
    </div>
  );
}
