'use client';

import { useEffect, useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createBuilderInvite, refreshBuilderTeam, saveBuilderTeam } from '@/lib/hq/actions/builders';
import { PROJECT_STAGES } from '@/lib/hq/builder-types';
import { groupedMaterials, SUBMISSION_LABELS } from '@/lib/hq/colosseum-snapshot';
import { joinLink } from '@/lib/hq/member-routes';
import type { MemberTeamView, TeamCaptainView } from '@/lib/hq/view-models';
import { BuilderProjectImage } from './builder-project-image';
import styles from './team-workspace.module.css';

function Disclosure({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <section className={styles.disclosure}>
    <h2 className={styles.disclosureTitle}><button type='button' className={styles.disclosureButton} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      {title}<span className={styles.chevron} aria-hidden='true'/>
    </button></h2>
    <div id={id} className={styles.disclosureBody} hidden={!open}>{children}</div>
  </section>;
}

function Feedback({ error, message }: { error: string; message?: string }) {
  if (error) return <p className={`${styles.feedback} ${styles.error}`} role='alert'>{error}</p>;
  return message ? <p className={styles.feedback} role='status'>{message}</p> : null;
}

function TeamMembers({ team }: { team: MemberTeamView }) {
  const joined = team.roster.filter(member => member.joined);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  const id = useId();
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  function toggleInvite() {
    setOpen(!open);
    if (open || url) return;
    start(async () => {
      setError('');
      try {
        const result = await createBuilderInvite({ projectId: team.id, hackathonId: team.edition.id });
        if (result.ok) setUrl(`${window.location.origin}${joinLink(result.data.code)}`);
        else setError(result.error);
      } catch { setError('Couldn’t create the link. Try again.'); }
    });
  }

  return <section className={styles.panel} aria-label='Team'>
    <div className={styles.panelHeading}><h2>Team</h2><span className={styles.count}>{joined.length} joined</span></div>
    {joined.length > 0 && <ul className={styles.members}>{joined.map(member => <li key={member.id}>
      <span><span className={styles.memberName}>{member.name}</span><span className={styles.memberHandle}>@{member.username}</span></span>
      {member.username === team.lead.username && <span className={styles.count}>Lead</span>}
    </li>)}</ul>}
    {team.membership.verification === 'verified' && <>
      <button type='button' className={styles.button} aria-expanded={open} aria-controls={id} onClick={toggleInvite} disabled={pending}>Invite teammates</button>
      <div id={id} className={styles.invite} hidden={!open}>
        {pending && <p role='status'>Creating link…</p>}
        {url && <>
          <label>Team join link<input value={url} readOnly onFocus={event => event.currentTarget.select()}/></label>
          <div className={styles.inviteActions}><button type='button' className={styles.button} onClick={async () => {
            try { await navigator.clipboard.writeText(url); setCopied(true); setError(''); }
            catch { setError('Select and copy the link above.'); }
          }}>{copied ? 'Copied' : 'Copy link'}</button></div>
          <p className={styles.quiet}>Share this link with your teammates.</p>
        </>}
        <Feedback error={error}/>
      </div>
    </>}
  </section>;
}

function Captain({ captain }: { captain: TeamCaptainView | null }) {
  if (!captain) return null;
  const contact = captain.contact;
  const href = contact && /^@[A-Za-z0-9_]{1,32}$/.test(contact) ? `https://t.me/${contact.slice(1)}`
    : contact && /^https:\/\//i.test(contact) ? contact
    : contact && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) ? `mailto:${contact}` : null;
  return <section className={styles.panel} aria-label='Captain'><h2>Captain</h2>
    <p className={styles.captainName}>{captain.displayName}</p>
    {contact && <p className={styles.captainContact}>{href ? <a href={href} target='_blank' rel='noopener noreferrer'>{contact}</a> : contact}</p>}
  </section>;
}

function ProjectDetails({ team, showRecheck }: { team: MemberTeamView; showRecheck: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const { source } = team;
  const materials = groupedMaterials(source);
  function refresh() {
    start(async () => {
      setError(''); setMessage('');
      try {
        const result = await refreshBuilderTeam({ projectId: team.id, hackathonId: team.edition.id });
        if (result.ok) { setMessage('Updated from Colosseum.'); router.refresh(); }
        else setError(result.error);
      } catch { setError('Couldn’t refresh Colosseum. Try again.'); }
    });
  }
  return <Disclosure title='Project details'>
    <dl className={styles.facts}>
      <div><dt>Stage</dt><dd>{PROJECT_STAGES.find(stage => stage.value === team.stage)?.label ?? team.stage}</dd></div>
      <div><dt>Submission</dt><dd>{SUBMISSION_LABELS[source.submissionStatus]}</dd></div>
      {source.category && <div><dt>Category</dt><dd>{source.category}</dd></div>}
      {source.tracks.length > 0 && <div><dt>Tracks</dt><dd>{source.tracks.join(', ')}</dd></div>}
    </dl>
    {(source.website || source.repoLink || materials.length > 0) && <ul className={styles.links}>
      {source.website && <li><a href={source.website} target='_blank' rel='noopener noreferrer'>Website</a></li>}
      {source.repoLink && <li><a href={source.repoLink} target='_blank' rel='noopener noreferrer'>Repository</a></li>}
      {materials.map(item => <li key={item.url}><a href={item.url} target='_blank' rel='noopener noreferrer'>{item.label}</a></li>)}
    </ul>}
    {showRecheck && <button type='button' className={styles.button} onClick={refresh} disabled={pending}>{pending ? 'Refreshing…' : 'Refresh from Colosseum'}</button>}
    {source.sourceStatus === 'error' && !error && <p className={styles.quiet}>Showing the last saved Colosseum details.</p>}
    <Feedback error={error} message={message}/>
  </Disclosure>;
}

function TeamSettings({ team }: { team: MemberTeamView }) {
  const router = useRouter();
  const [stage, setStage] = useState<string>(team.stage);
  const [lead, setLead] = useState(team.lead.username);
  const [pending, start] = useTransition();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  return <Disclosure title='Team settings'>
    <form className={styles.form} aria-busy={pending} onSubmit={event => {
      event.preventDefault();
      start(async () => {
        setError(''); setMessage('');
        try {
          const result = await saveBuilderTeam({ projectId: team.id, hackathonId: team.edition.id, stage, leadUsername: lead });
          if (result.ok) { setMessage('Saved.'); router.refresh(); }
          else setError(result.error);
        } catch { setError('Couldn’t save. Try again.'); }
      });
    }}>
      <label>Project stage<select value={stage} onChange={event => setStage(event.target.value)} disabled={pending}>{PROJECT_STAGES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label>Team lead<select value={lead} onChange={event => setLead(event.target.value)} disabled={pending}>{team.roster.map(member => <option key={member.id} value={member.username}>{member.name}</option>)}</select></label>
      <button className={`${styles.button} ${styles.primary}`} disabled={pending}>{pending ? 'Saving…' : 'Save changes'}</button>
      <Feedback error={error} message={message}/>
    </form>
  </Disclosure>;
}

export function TeamManagement({ team, showRecheck = true }: { team: MemberTeamView; showRecheck?: boolean }) {
  return <>
    <TeamMembers team={team}/>
    <Captain captain={team.captain}/>
    <div><ProjectDetails team={team} showRecheck={showRecheck}/>
      {team.membership.role === 'owner' && team.membership.verification === 'verified' && <TeamSettings team={team}/>}</div>
  </>;
}

export function TeamWorkspace({ project, team, showRecheck = true, showProjectLink = true, children }: {
  project: { name: string; edition: { name: string }; captain: TeamCaptainView | null };
  team?: MemberTeamView;
  showRecheck?: boolean;
  showProjectLink?: boolean;
  children: React.ReactNode;
}) {
  return <div className={styles.workspace}>
    <div className={styles.heading}>
      <div className={styles.identity}>
        {team?.source.imageUrl && <BuilderProjectImage src={team.source.imageUrl} name={team.name} size={56}/>}
        <div><h1>{project.name}</h1><p className={styles.edition}>{project.edition.name}</p></div>
      </div>
      {team && showProjectLink && <a className={styles.button} href={team.projectUrl} target='_blank' rel='noopener noreferrer'>View on Colosseum</a>}
    </div>
    <div className={styles.layout}>
      <div className={styles.content}>{children}</div>
      <aside className={styles.sidebar} aria-label='Team details'>
        {team ? <TeamManagement team={team} showRecheck={showRecheck}/> : <>
          <Captain captain={project.captain}/>
          <Disclosure title='Project details'><p className={styles.quiet}>Colosseum isn’t linked yet.</p></Disclosure>
        </>}
      </aside>
    </div>
  </div>;
}
