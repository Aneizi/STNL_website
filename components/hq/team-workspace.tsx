'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { IconArrowLeft } from 'symbols-react';
import { createBuilderInvite, saveBuilderTeam } from '@/lib/hq/actions/builders';
import { addReportingUpdate, loadTeamUpdates, saveTeamContact } from '@/lib/hq/actions/reporting';
import { setBotMessaging } from '@/lib/hq/actions/telegram';
import { PROJECT_STAGES, type ProjectStage } from '@/lib/hq/builder-types';
import { SUBMISSION_LABELS, type SubmissionStatus } from '@/lib/hq/colosseum-snapshot';
import { joinLink } from '@/lib/hq/member-routes';
import type { ReportingEntryView } from '@/lib/hq/reporting';
import type { TeamReportingPanel } from '@/lib/hq/reporting-surface';
import {
  dueLine,
  EARLIER_NOTE,
  entryMetaLabel,
  HEADING_DONE,
  HEADING_OPEN,
  isWeekStarted,
  MAX_CONTACT_LENGTH,
  mergeUpdatePages,
  SAVED_LABEL,
  telegramContactHref,
  UPDATE_SAVED,
  UPDATED_LABEL,
  weekOfLabel,
} from '@/lib/hq/reporting-view';
import { BuilderProjectImage } from './builder-project-image';
import { LateUpdateModal } from './late-update-modal';
import { ReportingEntryCard } from './reporting-entry-card';
import { TelegramBotStart } from './telegram-bot-start';
import styles from './team-workspace.module.css';

/**
 * The team dossier: the ink aside (identity, roster, Captain, project facts,
 * the two view switches) beside the main column, which shows this week's
 * composer and the Earlier list, or the Team settings or Contact preference
 * form in its place.
 *
 * The server decided everything about access before this rendered: which
 * team, which entries, whether the viewer leads it. What lives here is the
 * view state and the drafts, kept across view switches (the update column
 * is hidden, not unmounted, while a form is open) and across the refresh a
 * save triggers.
 */

/** The same limit the service enforces (`MAX_BODY_LENGTH`), repeated here because that module is server only. */
const MAX_BODY = 4000;
const SAVE_FAILED = 'The update could not be saved. Your text is kept. Try again.';
const SETTINGS_FAILED = 'Could not save. Try again.';
const LINK_FAILED = 'Could not create the link. Try again.';
const LOAD_FAILED = 'The updates could not be loaded. Try again.';
const BOT_NOT_CONNECTED = 'Connect Telegram in Account first.';
const HACKATHON_NAME = "Crypto World's Fair";
const STAGE_LABELS: Record<string, string> = Object.fromEntries(PROJECT_STAGES.map(stage => [stage.value, stage.label]));

/** The reporting half the dossier renders: the panel without the final-period detail this page has no block for. */
export type TeamReportingProps = Pick<TeamReportingPanel, 'projectId' | 'hackathonId' | 'timezone' | 'enrolled' | 'paused' | 'current' | 'history' | 'totalPeriods' | 'entries' | 'nextCursor' | 'teamContact'>;

/** The Colosseum half of a team. Null for a project an operator created from a Request help submission, which has none of it yet. */
export type TeamSnapshotProps = {
  imageUrl: string | null;
  projectUrl: string;
  stage: ProjectStage;
  category: string | null;
  submissionStatus: SubmissionStatus;
  website: string | null;
  repoLink: string | null;
  leadUsername: string;
  /** Every roster row, joined or not: the list shows the joined, the lead select offers them all. No account id is included. */
  roster: { name: string; username: string; joined: boolean }[];
};

export type TeamWorkspaceProps = {
  project: { name: string; captain: { displayName: string; contact: string | null } | null };
  team: TeamSnapshotProps | null;
  reporting: TeamReportingProps;
  /** The verified team lead: the one account that may change the stage, the lead and the team contact. */
  canEditTeam: boolean;
  /** A verified teammate, who may create and share the join link. */
  canInvite: boolean;
  /** The page's request instant, so the kicker and the modal's week states answer to the same moment as the panel. */
  nowMs: number;
  hasTelegram: boolean;
  /** The stored bot consent, read on the server. False without a Telegram identity, which cannot hold one. */
  botAllowed: boolean;
  botUrl: string | null;
};

type View = 'update' | 'settings' | 'contact';
type Saved = (entry: ReportingEntryView, completesPeriod: boolean) => void;

/** A link from the Colosseum snapshot, rendered only when it is shaped like a web address. */
const httpUrl = (value: string | null): string | null => (value && /^https?:\/\//i.test(value) ? value : null);

function BackButton({ onClick }: { onClick: () => void }) {
  return <button type='button' className={styles.backButton} onClick={onClick}>
    <IconArrowLeft width={16} height={16} fill='currentColor' aria-hidden='true'/>Back to updates
  </button>;
}

/** The join link: created on the first open, shown once it arrives, copied with one press. */
function InviteControl({ projectId, hackathonId }: { projectId: string; hackathonId: number }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [, start] = useTransition();
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const toggle = () => {
    setOpen(!open);
    if (open || url) return;
    start(async () => {
      setError('');
      try {
        const result = await createBuilderInvite({ projectId, hackathonId });
        if (result.ok) setUrl(`${window.location.origin}${joinLink(result.data.code)}`);
        else setError(result.error);
      } catch { setError(LINK_FAILED); }
    });
  };
  const copy = async () => {
    setError('');
    setCopied(false);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError('Could not copy. Select the link and copy it manually.');
    }
  };

  return <>
    <button type='button' className={styles.inviteToggle} aria-expanded={open} onClick={toggle}>{open ? 'Hide join link' : 'Invite teammates'}</button>
    {open && <div className={styles.invite}>
      {url && <input className={styles.inviteInput} value={url} readOnly onFocus={event => event.currentTarget.select()} aria-label='Team join link'/>}
      {url && <button type='button' className={styles.copyButton} onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>}
      {error && <p role='alert' className={styles.asideAlert}>{error}</p>}
    </div>}
  </>;
}

/**
 * This week's kicker, heading and composer. The save is bound to the week
 * the box was opened against (`expectedPeriodId`), so a save that crossed
 * midnight comes back as a refusal with the text kept rather than landing
 * on a week nobody chose. Without an open week there is nothing to add to,
 * so only the late-update link remains, and only once a week has started.
 */
function UpdateComposer({ reporting, completed, nowMs, onSaved, onOpenLate, lateButtonRef }: {
  reporting: TeamReportingProps;
  completed: boolean;
  nowMs: number;
  onSaved: Saved;
  onOpenLate: () => void;
  lateButtonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [draftPeriodId, setDraftPeriodId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const { projectId, hackathonId, current, enrolled, paused, history, totalPeriods, timezone } = reporting;
  const canCompose = enrolled && !paused && current !== null;
  const lateAvailable = enrolled && !paused && history.some(period => isWeekStarted(period, nowMs));

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!current || !body.trim()) return;
    start(async () => {
      setError('');
      let result;
      try {
        result = await addReportingUpdate({ projectId, hackathonId, body, expectedPeriodId: draftPeriodId ?? current.periodId });
      } catch {
        setError(SAVE_FAILED);
        return;
      }
      if (result.ok) {
        onSaved(result.entry, result.completesPeriod);
        setBody('');
        setDraftPeriodId(null);
        setSaved(true);
        router.refresh();
        return;
      }
      setError(result.error);
      // Learn the next week without changing the week attached to this draft.
      if (result.reason === 'period_changed' && result.currentPeriod) router.refresh();
    });
  };

  const lateLink = <button type='button' className={styles.lateLink} onClick={onOpenLate} ref={lateButtonRef} aria-haspopup='dialog'>{"Missed a week's update?"}</button>;
  if (!canCompose || !current) return lateAvailable ? <div className={styles.row}>{lateLink}</div> : null;

  return <>
    <p className={`${styles.weekKicker} ${completed ? styles.weekDone : ''}`}>
      {weekOfLabel(current.periodSequence, totalPeriods)}.{' '}
      <span className={styles.weekLine}>{completed ? UPDATED_LABEL : dueLine(current.endsAt, timezone)}</span>
    </p>
    <h2 className={styles.heading}>{completed ? HEADING_DONE : HEADING_OPEN}</h2>
    {saved && <p role='status' className={styles.savedStatus}>{UPDATE_SAVED}</p>}
    <form className={styles.composer} onSubmit={submit} aria-busy={pending}>
      <textarea className={styles.updateBox} value={body} onChange={event => {
        if (!body.trim()) setDraftPeriodId(current.periodId);
        setBody(event.target.value); setSaved(false);
      }} maxLength={MAX_BODY} rows={6} aria-label='Your update' placeholder='What moved, what is in the way, what is next.'/>
      {body.trim() && draftPeriodId !== null && draftPeriodId !== current.periodId && <div>
        <p role='alert' className={styles.alert}>The week changed while you were writing. Your draft is kept.</p>
        <button type='button' className={styles.lateLink} onClick={() => { setDraftPeriodId(current.periodId); setError(''); }}>Use current week</button>
      </div>}
      <div className={styles.row}>
        <button type='submit' className={styles.addButton} disabled={!body.trim() || pending}>Add update</button>
        {lateLink}
      </div>
      {error && <p role='alert' className={styles.alert}>{error}</p>}
    </form>
  </>;
}

/** The Earlier list: the first page from the server, saved entries merged in, older pages loaded behind the cursor. */
function EarlierList({ reporting, entries, onSaved }: { reporting: TeamReportingProps; entries: ReportingEntryView[]; onSaved: Saved }) {
  const { projectId, hackathonId, timezone } = reporting;
  const [older, setOlder] = useState<ReportingEntryView[]>([]);
  // Where the next page starts. The server's cursor until an older page has
  // been loaded here, so a first page that grows past its limit after a
  // refresh still offers the rest; the loaded page's own cursor after that.
  const [loadedCursor, setLoadedCursor] = useState<string | null | undefined>(undefined);
  const cursor = loadedCursor === undefined ? reporting.nextCursor : loadedCursor;
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const shown = mergeUpdatePages(entries, older);

  const loadOlder = () => start(async () => {
    if (!cursor) return;
    setError('');
    try {
      const page = await loadTeamUpdates({ projectId, hackathonId, cursor });
      setOlder(previous => mergeUpdatePages(previous, page.entries));
      setLoadedCursor(page.nextCursor);
    } catch { setError(LOAD_FAILED); }
  });

  return <section className={styles.earlier} aria-labelledby='earlier-title'>
    <h3 id='earlier-title' className={styles.earlierTitle}>Earlier</h3>
    <p className={styles.earlierNote}>{EARLIER_NOTE}</p>
    {shown.length > 0 && <div className={styles.entries}>
      {shown.map(entry => <ReportingEntryCard key={entry.id} entry={entry} meta={entryMetaLabel(entry, timezone)} canEdit={entry.canEdit} onSaved={saved => onSaved(saved, false)}/>)}
    </div>}
    {error && <p role='alert' className={styles.alert}>{error}</p>}
    {cursor && <button type='button' className={styles.older} disabled={pending} onClick={loadOlder}>Show older updates</button>}
  </section>;
}

/** Project stage and team lead, the verified lead's to change. */
function SettingsView({ reporting, team, onBack }: { reporting: TeamReportingProps; team: TeamSnapshotProps; onBack: () => void }) {
  const router = useRouter();
  const [stage, setStage] = useState<string>(team.stage);
  const [lead, setLead] = useState(team.leadUsername);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    start(async () => {
      setError('');
      let result;
      try {
        result = await saveBuilderTeam({ projectId: reporting.projectId, hackathonId: reporting.hackathonId, stage, leadUsername: lead });
      } catch {
        setError(SETTINGS_FAILED);
        return;
      }
      if (result.ok) {
        setSaved(true);
        router.refresh();
        return;
      }
      setError(result.error);
    });
  };

  return <>
    <BackButton onClick={onBack}/>
    <h2 className={styles.viewHeading}>Team settings</h2>
    <form className={styles.settingsForm} onSubmit={submit} aria-busy={pending}>
      <label className={styles.field}>Project stage<select className={styles.select} value={stage} onChange={event => { setStage(event.target.value); setSaved(false); }}>
        {PROJECT_STAGES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select></label>
      <label className={styles.field}>Team lead<select className={styles.select} value={lead} onChange={event => { setLead(event.target.value); setSaved(false); }}>
        {team.roster.map(member => <option key={member.username} value={member.username}>{member.name}</option>)}
      </select></label>
      {error && <p role='alert' className={styles.alert}>{error}</p>}
      <div className={styles.row}>
        <button type='submit' className={styles.saveButton} disabled={pending}>Save</button>
        {saved && <span role='status' className={styles.saved}>{SAVED_LABEL}</span>}
      </div>
    </form>
  </>;
}

/**
 * The team contact (the lead's to set) and the bot consent (each account's
 * own). Two writes behind one Save; "Saved." only once every write that
 * applies succeeded. Consent lives on the Telegram identity, so without one
 * the checkbox stays unchecked and inert rather than asking for a refusal.
 */
function ContactView({ reporting, canEditTeam, hasTelegram, botAllowed: storedConsent, botUrl, onBack }: {
  reporting: TeamReportingProps;
  canEditTeam: boolean;
  hasTelegram: boolean;
  botAllowed: boolean;
  botUrl: string | null;
  onBack: () => void;
}) {
  const router = useRouter();
  const [contact, setContact] = useState(reporting.teamContact ?? '');
  const [botAllowed, setBotAllowed] = useState(storedConsent);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    start(async () => {
      setError('');
      try {
        if (canEditTeam) {
          const result = await saveTeamContact({ projectId: reporting.projectId, hackathonId: reporting.hackathonId, contact });
          if (!result.ok) { setError(result.error); return; }
        }
        if (hasTelegram) {
          const result = await setBotMessaging(botAllowed);
          if (!result.ok) { setError(BOT_NOT_CONNECTED); return; }
        }
      } catch {
        setError(SETTINGS_FAILED);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  };

  return <>
    <BackButton onClick={onBack}/>
    <h2 className={styles.viewHeading}>Contact preference</h2>
    <form className={styles.settingsForm} onSubmit={submit} aria-busy={pending}>
      {canEditTeam && <label className={styles.field}>Team contact
        <input type='text' className={styles.textInput} value={contact} onChange={event => { setContact(event.target.value); setSaved(false); }} maxLength={MAX_CONTACT_LENGTH} placeholder='Telegram handle or email'/>
        <span className={styles.hint}>Shared with your Captain and Superteam NL.</span>
      </label>}
      <label className={`${styles.check} ${hasTelegram ? '' : styles.checkDisabled}`}>
        <input type='checkbox' checked={botAllowed} disabled={!hasTelegram} onChange={event => { setBotAllowed(event.target.checked); setSaved(false); }}/>
        Allow the Superteam NL bot to reach you on Telegram for reminders
      </label>
      {hasTelegram && <TelegramBotStart botUrl={botUrl} />}
      {error && <p role='alert' className={styles.alert}>{error}</p>}
      <div className={styles.row}>
        <button type='submit' className={styles.saveButton} disabled={pending}>Save</button>
        {saved && <span role='status' className={styles.saved}>{SAVED_LABEL}</span>}
      </div>
    </form>
  </>;
}

export function TeamWorkspace({ project, team, reporting, canEditTeam, canInvite, nowMs, hasTelegram, botAllowed, botUrl }: TeamWorkspaceProps) {
  const [view, setView] = useState<View>('update');
  const [lateOpen, setLateOpen] = useState(false);
  const [saved, setSaved] = useState<ReportingEntryView[]>([]);
  // The week an update completed on this page, so the kicker turns green at
  // once; the refreshed panel says the same a moment later, and a new week
  // starts Not updated again because its id differs.
  const [completedPeriodId, setCompletedPeriodId] = useState<string | null>(null);
  const lateButtonRef = useRef<HTMLButtonElement>(null);
  const { current } = reporting;
  const completed = current !== null && (current.completed || completedPeriodId === current.periodId);
  const entries = mergeUpdatePages(reporting.entries, saved);

  const record = useCallback<Saved>((entry, completesPeriod) => {
    setSaved(previous => mergeUpdatePages(previous, [entry]));
    if (completesPeriod) setCompletedPeriodId(entry.periodId);
  }, []);
  const closeLate = useCallback(() => {
    setLateOpen(false);
    lateButtonRef.current?.focus();
  }, []);
  const backToUpdate = useCallback(() => setView('update'), []);

  const captain = project.captain;
  const captainHref = telegramContactHref(captain?.contact);
  const joined = team ? team.roster.filter(member => member.joined) : [];
  const website = httpUrl(team?.website ?? null);
  const repoLink = httpUrl(team?.repoLink ?? null);
  const footButton = (target: View, label: string) =>
    <button type='button' className={`${styles.footButton} ${view === target ? styles.footActive : ''}`} aria-current={view === target ? 'true' : undefined} onClick={() => setView(target)}>{label}</button>;

  return <>
    <div className={styles.shell}>
      <aside className={styles.aside} aria-label='Team details'>
        <Link href='/hq/dashboard' className={styles.homeLink}><IconArrowLeft width={16} height={16} fill='currentColor' aria-hidden='true'/>Home</Link>
        <div className={styles.identity}>
          <BuilderProjectImage src={team?.imageUrl ?? null} name={project.name} size={64} radius={0} fit='cover' className={styles.logo}/>
          <h1 className={styles.title}>{project.name}</h1>
          <p className={styles.edition}>{HACKATHON_NAME}</p>
          {team && <a className={styles.projectLink} href={team.projectUrl} target='_blank' rel='noopener noreferrer'>View on Colosseum</a>}
        </div>
        <div className={styles.asideGrid}>
          {team && <section aria-label='Team'>
            <div className={styles.sectionHead}><h2 className={styles.kicker}>Team</h2><span className={styles.joined}>{joined.length} joined</span></div>
            <ul className={styles.roster}>
              {joined.map(member => <li key={member.username}>
                <span className={styles.memberName}>{member.name}</span>
                {member.username === team.leadUsername && <span className={styles.leadTag}>Lead</span>}
              </li>)}
            </ul>
            {canInvite && <InviteControl projectId={reporting.projectId} hackathonId={reporting.hackathonId}/>}
          </section>}
          {captain && <section aria-label='Captain'>
            <h2 className={`${styles.kicker} ${styles.kickerSpaced}`}>Captain</h2>
            <p className={styles.captainName}>{captain.displayName}</p>
            {captain.contact && (captainHref
              ? <a className={styles.captainLink} href={captainHref} target='_blank' rel='noopener noreferrer'>{captain.contact}</a>
              : <p className={styles.captainContact}>{captain.contact}</p>)}
          </section>}
          {team && <section aria-label='Project'>
            <h2 className={`${styles.kicker} ${styles.kickerSpaced}`}>Project</h2>
            <dl className={styles.facts}>
              <dt>Stage</dt><dd>{STAGE_LABELS[team.stage] ?? team.stage}</dd>
              {team.category && <><dt>Category</dt><dd>{team.category}</dd></>}
              <dt>Submission</dt><dd>{SUBMISSION_LABELS[team.submissionStatus]}</dd>
            </dl>
            {(website || repoLink) && <div className={styles.projectLinks}>
              {website && <a className={styles.factLink} href={website} target='_blank' rel='noopener noreferrer'>Website</a>}
              {repoLink && <a className={styles.factLink} href={repoLink} target='_blank' rel='noopener noreferrer'>Repository</a>}
            </div>}
          </section>}
        </div>
        <div className={styles.asideFoot}>
          {canEditTeam && team && footButton('settings', 'Team settings')}
          {footButton('contact', 'Contact preference')}
        </div>
      </aside>
      <div className={styles.main}>
        <div hidden={view !== 'update'}>
          <UpdateComposer reporting={reporting} completed={completed} nowMs={nowMs} onSaved={record} onOpenLate={() => setLateOpen(true)} lateButtonRef={lateButtonRef}/>
          <EarlierList reporting={reporting} entries={entries} onSaved={record}/>
        </div>
        {view === 'settings' && team && <SettingsView reporting={reporting} team={team} onBack={backToUpdate}/>}
        {view === 'contact' && <ContactView reporting={reporting} canEditTeam={canEditTeam && team !== null} hasTelegram={hasTelegram} botAllowed={botAllowed} botUrl={botUrl} onBack={backToUpdate}/>}
      </div>
    </div>
    {lateOpen && <LateUpdateModal projectId={reporting.projectId} hackathonId={reporting.hackathonId} periods={reporting.history} nowMs={nowMs} onClose={closeLate} onSaved={record}/>}
  </>;
}
