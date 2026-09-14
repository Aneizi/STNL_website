'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { IconArrowRight, IconTelegramLogo } from 'symbols-react';
import { acceptBuilderInvite, chooseBuilderPath, createBuilderInvite, importBuilderTeam, previewBuilderInvite, refreshBuilderTeam, requestBuilderEvent, requestBuilderReview, saveBuilderTeam } from '@/lib/hq/actions/builders';
import { PROJECT_STAGES, type BuilderHackathon, type BuilderTeamSource } from '@/lib/hq/builder-types';
import { groupedMaterials, SUBMISSION_LABELS } from '@/lib/hq/colosseum-snapshot';
import { SUPERTEAM_NL_TELEGRAM_GROUP, SUPERTEAM_NL_TELEGRAM_GROUP_LABEL } from '@/lib/hq/community';
import { fmtDateRange } from '@/lib/hq/hackathon-format';
import { joinLink, parseJoinCode } from '@/lib/hq/member-routes';
import type { MemberTeamView } from '@/lib/hq/view-models';
import { BuilderProjectImage } from './builder-project-image';
import styles from './builder-shell.module.css';

function Arrow() { return <IconArrowRight width={20} height={20} fill='currentColor' aria-hidden='true'/>; }
function ErrorText({error}:{error:string}) { return error ? <p role='alert' className={styles.error}>{error}</p> : null; }
function StageField({value,onChange}:{value:string;onChange:(value:string)=>void}) { return <label className={styles.field}>Where is your project today?<select value={value} onChange={e=>onChange(e.target.value)}>{PROJECT_STAGES.map(s=><option key={s.value} value={s.value}>{s.label}</option>)}</select></label>; }

/**
 * The Superteam NL Telegram group as a logo control with an accessible name.
 * The raw invite string is never the link text and never rendered anywhere:
 * the icon plus its accessible name is the whole control, per the plan's
 * "rendered as a Telegram logo control with an accessible name, never a bare
 * URL". The icon follows the repository convention (`symbols-react`,
 * `fill="currentColor"`).
 */
function TelegramGroupControl() {
  return <a className={styles.inlineLink} href={SUPERTEAM_NL_TELEGRAM_GROUP} target='_blank' rel='noopener noreferrer'
    aria-label={SUPERTEAM_NL_TELEGRAM_GROUP_LABEL} title={SUPERTEAM_NL_TELEGRAM_GROUP_LABEL}
    style={{display:'inline-flex',alignItems:'center',gap:8}}>
    <IconTelegramLogo width={24} height={24} fill='currentColor' aria-hidden='true'/>
    <span>{SUPERTEAM_NL_TELEGRAM_GROUP_LABEL}</span>
  </a>;
}

/** Copy-to-clipboard for a join link. Local to the member shell: components/hq/ui-client.tsx is operator-side. */
function CopyLink({value}:{value:string}) {
  const [copied,setCopied]=useState(false);
  useEffect(()=>{ if(!copied) return; const timer=setTimeout(()=>setCopied(false),2000); return ()=>clearTimeout(timer); },[copied]);
  return <button type='button' className={styles.secondary} onClick={async()=>{
    try { await navigator.clipboard.writeText(value); setCopied(true); } catch { setCopied(false); }
  }}>{copied?'Copied':'Copy link'}</button>;
}

export function BuilderWelcome({hackathons}:{hackathons:BuilderHackathon[]}) {
  const router = useRouter();
  const [selected,setSelected] = useState(hackathons[0]?.id??0);
  const [pending,start] = useTransition();
  const [error,setError] = useState('');
  const choose = (path:'initialize'|'join'|'supporter') => start(async()=>{
    setError(''); const result = await chooseBuilderPath({hackathonId:selected,path});
    if (result.ok) router.push(result.data.url); else setError(result.error);
  });
  if (!hackathons.length) return <p>There are no open hackathons yet. Your account is ready. Check back soon.</p>;
  return <>
    <label className={styles.field}>Your hackathon<select value={selected} onChange={e=>setSelected(Number(e.target.value))}>{hackathons.map(h=><option value={h.id} key={h.id}>{h.name}</option>)}</select></label>
    <div className={styles.choices}>
      <button className={styles.choice} disabled={pending} onClick={()=>choose('initialize')}><span><strong>Import your team</strong><span>Bring your project and teammates in from Colosseum, in one step.</span></span><Arrow/></button>
      <button className={styles.choice} disabled={pending} onClick={()=>choose('join')}><span><strong>Join a team</strong><span>Use the join link a teammate sent you.</span></span><Arrow/></button>
    </div>
    <button className={styles.textButton} disabled={pending} onClick={()=>choose('supporter')}>I’m not building this time</button>
    <ErrorText error={error}/>
  </>;
}

/**
 * The self-service import, in one step: paste the Colosseum project link,
 * press the button, and a Dutch project registered for this edition is in
 * HQ. There is no preview step, no teammate selection, no verification code
 * and no pending state — the owner removed all of it on 14 September 2026.
 *
 * Every failure gets its own message from the server (one HQ-authored string
 * per `ImportFailureReason`), and two of them change the screen rather than
 * just the text: `already_imported` offers the Telegram group control
 * instead of a retry, and the transport failures (`retry`) say so plainly.
 */
export function BuilderInitialize({hackathon,available}:{hackathon:BuilderHackathon;available:boolean}) {
  const router=useRouter();
  const [url,setUrl]=useState('');
  const [note,setNote]=useState('');
  const [failure,setFailure]=useState<{message:string;reason?:string;retry?:boolean}|null>(null);
  const [pending,start]=useTransition();
  const submit=(e:React.FormEvent)=>{e.preventDefault();start(async()=>{
    setFailure(null);
    const result=await importBuilderTeam({hackathonId:hackathon.id,url});
    if (result.ok) { router.replace(result.data.url); return; }
    setFailure({message:result.error,reason:'reason' in result?result.reason:undefined,retry:'retry' in result?result.retry:false});
  });};
  const review=(e:React.FormEvent)=>{e.preventDefault();start(async()=>{
    setFailure(null);const result=await requestBuilderReview({hackathonId:hackathon.id,url,note});
    if(result.ok)router.replace(result.data.url);else setFailure({message:result.error});
  });};
  return <>
    {!available
      ? <section className={styles.notice}><h2>Your account is ready.</h2><p>Colosseum project access opens at the start of the hackathon. Come back then to import your team.</p><p>{fmtDateRange(hackathon.startDate,hackathon.endDate)}</p><Link className={styles.inlineLink} href='/hq/dashboard'>Go to my HQ</Link></section>
      : <p>Your team starts on Colosseum. Paste its project link and we’ll bring the project, its details and its team into HQ. Your project has to be registered under <strong>Netherlands</strong> for this hackathon.</p>}
    {available && <form className={styles.form} onSubmit={submit}>
      <label className={styles.field}>Colosseum project link<input type='url' value={url} onChange={e=>setUrl(e.target.value)} placeholder='https://colosseum.com/arena/projects/explore/…' required maxLength={2048}/></label>
      <button className={styles.button} disabled={pending}>{pending?'Importing…':'Import my team'}<Arrow/></button>
    </form>}
    {failure && <section className={styles.notice} role='alert' aria-live='polite'>
      <p className={styles.error}>{failure.message}</p>
      {failure.reason==='already_imported' && <>
        <p>We can’t say who imported it. If it should be yours, or you need to be added to it, ask us in the group and we’ll sort it out.</p>
        <TelegramGroupControl/>
      </>}
      {failure.retry && <p>Nothing about your project is wrong. Press Import my team again in a moment.</p>}
    </section>}
    <details className={styles.details}><summary>Can’t get your project in?</summary><p>Share its link and what went wrong. We’ll pick it up in HQ.</p><form className={styles.form} onSubmit={review}><label className={styles.field}>Project link<input type='url' value={url} onChange={e=>setUrl(e.target.value)} required maxLength={400}/></label><label className={styles.field}>How can we help?<textarea value={note} onChange={e=>setNote(e.target.value)} minLength={5} maxLength={1500} required/></label><button className={styles.secondary} disabled={pending}>Request help</button></form></details>
  </>;
}

/**
 * Joining by link. Accepts the whole pasted link or a bare code, so a
 * trailing slash, surrounding whitespace or a tracking query a messenger
 * appended does not turn a valid invitation into an error. The same
 * `parseJoinCode` runs again on the server, which is the check that counts.
 */
export function BuilderJoin({initialCode=''}:{initialCode?:string}) {
  const router=useRouter();
  const [pasted,setPasted]=useState(initialCode);
  const [confirmed,setConfirmed]=useState(false);
  const [invite,setInvite]=useState<{name:string;username:string;team:string;code:string}|null>(null);
  const [error,setError]=useState('');
  const [pending,start]=useTransition();
  const lookup=(value:string)=>start(async()=>{
    setError('');const result=await previewBuilderInvite(value);
    if(result.ok)setInvite(result.data);else setError(result.error);
  });
  // A teammate who clicked the link they were sent lands here with the code
  // already in the address; looking it up straight away saves them pressing
  // a button to confirm what they just clicked.
  // Runs once for the code that arrived in the address. `lookup` is stable
  // enough for this purpose and is deliberately not a dependency: re-running
  // the lookup on every render of this form is not what "look up what the
  // link carried" means.
  useEffect(()=>{ if(initialCode && parseJoinCode(initialCode)) lookup(initialCode); },[initialCode]);
  const join=(e:React.FormEvent)=>{e.preventDefault();start(async()=>{
    setError('');const result=await acceptBuilderInvite({code:invite!.code,confirmed});
    if(result.ok)router.replace(result.data.url);else setError(result.error);
  });};
  return <>{!invite
    ? <form className={styles.form} onSubmit={e=>{e.preventDefault();lookup(pasted);}}>
        <label className={styles.field}>Your join link<input value={pasted} onChange={e=>setPasted(e.target.value)} autoComplete='off' spellCheck={false} required maxLength={2048} placeholder='Paste the link your teammate sent you'/></label>
        <button className={styles.button} disabled={pending}>{pending?'Checking…':'Find my team'}<Arrow/></button>
      </form>
    : <form className={styles.form} onSubmit={join}>
        <section className={styles.notice}><h2>{invite.team}</h2><p>This link is for <strong>{invite.name}</strong>, @{invite.username} on Colosseum.</p></section>
        <label className={styles.check}>That’s me<input type='checkbox' required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/></label>
        <button className={styles.button} disabled={pending||!confirmed}>{pending?'Joining…':'Join team'}<Arrow/></button>
        <button type='button' className={styles.textButton} onClick={()=>{setInvite(null);setConfirmed(false);setError('');}}>Use another link</button>
      </form>}
    <ErrorText error={error}/>
  </>;
}

const SUBMISSION_TONE: Record<BuilderTeamSource['submissionStatus'], string> = {
  submitted: '#2a604a', not_submitted: '#a52b16', not_checked: '#57534a',
};

/**
 * Colosseum submission as a badge with text, never colour alone: green
 * Submitted, red Not submitted, neutral Not checked. The status comes from
 * the stored snapshot, which only `interpretSubmission` ever writes, so this
 * component cannot invent one of its own.
 */
export function SubmissionBadge({source}:{source:BuilderTeamSource}) {
  return <span style={{display:'inline-flex',alignItems:'center',gap:8,color:SUBMISSION_TONE[source.submissionStatus],fontWeight:600}}>
    <span aria-hidden='true' style={{width:10,height:10,borderRadius:'50%',background:'currentColor'}}/>
    {SUBMISSION_LABELS[source.submissionStatus]}
  </span>;
}

/** The imported Colosseum details, as the team and its Captain both see them. */
export function TeamSourceDetails({name,projectUrl,source}:{name:string;projectUrl:string;source:BuilderTeamSource}) {
  const materials = groupedMaterials(source);
  return <section className={styles.card}>
    <div style={{display:'flex',gap:16,alignItems:'flex-start'}}>
      <BuilderProjectImage src={source.imageUrl} name={name} size={72}/>
      <div style={{minWidth:0}}>
        <SubmissionBadge source={source}/>
        {source.category && <p>Category: {source.category}</p>}
        {source.tracks.length>0 && <p>Tracks: {source.tracks.join(', ')}</p>}
        {source.twitterHandle && <p>X handle on Colosseum: @{source.twitterHandle}</p>}
      </div>
    </div>
    <p><a className={styles.inlineLink} href={projectUrl} target='_blank' rel='noopener noreferrer'>View project on Colosseum</a></p>
    {(source.website||source.repoLink) && <p>
      {source.website && <><a className={styles.inlineLink} href={source.website} target='_blank' rel='noopener noreferrer'>Website</a>{source.repoLink?' · ':''}</>}
      {source.repoLink && <a className={styles.inlineLink} href={source.repoLink} target='_blank' rel='noopener noreferrer'>Repository</a>}
    </p>}
    {materials.length>0 && <ul style={{margin:'0 0 22px',paddingLeft:18}}>
      {materials.map(item=><li key={item.url}><a className={styles.inlineLink} href={item.url} target='_blank' rel='noopener noreferrer'>{item.label}</a></li>)}
    </ul>}
    {source.completion && <p>Colosseum readiness: {source.completion.isComplete?'complete':`${source.completion.missingCount} field${source.completion.missingCount===1?'':'s'} still to fill in`}. Readiness is not submission.</p>}
    <p>{source.sourceCheckedAt?`Last read from Colosseum on ${source.sourceCheckedAt.slice(0,10)}.`:'Not read from Colosseum yet.'}{source.sourceStatus==='error'?' The last check did not get through; this is the previous known state.':''}</p>
  </section>;
}

export function BuilderTeamControls({team}:{team:MemberTeamView}) {
  // Edits and join links are the team lead's; the server decides again on every call.
  const editable=team.membership.role==='owner'&&team.membership.verification==='verified';
  const router=useRouter();
  const [stage,setStage]=useState<string>(team.stage);
  const [lead,setLead]=useState(team.lead.username);
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  const [invite,setInvite]=useState<{name:string;url:string}|null>(null);
  const [pending,start]=useTransition();
  const save=(e:React.FormEvent)=>{e.preventDefault();start(async()=>{setError('');setMessage('');const result=await saveBuilderTeam({projectId:team.id,hackathonId:team.edition.id,stage,leadUsername:lead});if(result.ok){setMessage('Saved.');router.refresh();}else setError(result.error);});};
  const create=(memberId:string,name:string)=>start(async()=>{
    setError('');const result=await createBuilderInvite({projectId:team.id,hackathonId:team.edition.id,memberId});
    if(result.ok)setInvite({name,url:`${window.location.origin}${joinLink(result.data.code)}`});else setError(result.error);
  });
  const recheck=()=>start(async()=>{
    setError('');setMessage('');
    const result=await refreshBuilderTeam({projectId:team.id,hackathonId:team.edition.id});
    if(result.ok){setMessage('Checked with Colosseum.');router.refresh();}else setError(result.error);
  });
  return <>
    <TeamSourceDetails name={team.name} projectUrl={team.projectUrl} source={team.source}/>
    <div className={styles.actions}><button className={styles.secondary} disabled={pending} onClick={recheck}>{pending?'Checking…':'Check submission'}</button></div>
    <section className={styles.card}><h2>Your team</h2>
      {team.roster.map(m=><div className={styles.row} key={m.id}>
        <div>{m.name}{m.username===team.lead.username?' (lead)':''}<small>@{m.username}</small></div>
        {m.joined?<span>Joined</span>:editable?<button className={styles.secondary} disabled={pending} onClick={()=>create(m.id,m.name)}>Join link</button>:<span>Not joined</span>}
      </div>)}
    </section>
    {invite&&<section className={styles.notice} aria-live='polite'><h2>Join link for {invite.name}</h2>
      <p>Send this link privately to {invite.name}. It works once, for that seat only, and expires in 48 hours. If the seat is yours, open it yourself to claim it.</p>
      <output className={styles.code} style={{fontSize:16,letterSpacing:0}}>{invite.url}</output>
      <div className={styles.actions}><CopyLink value={invite.url}/></div>
    </section>}
    {editable&&<form className={styles.form} onSubmit={save}><StageField value={stage} onChange={setStage}/><label className={styles.field}>Team lead<select value={lead} onChange={e=>setLead(e.target.value)}>{team.roster.map(m=><option key={m.id} value={m.username}>{m.name}</option>)}</select></label><button className={styles.secondary} disabled={pending}>Save changes</button></form>}
    <ErrorText error={error}/>{message&&<p role='status' className={styles.success}>{message}</p>}
  </>;
}

export function BuilderHostApplication({hackathons}:{hackathons:BuilderHackathon[]}) {
  const router=useRouter();const[id,setId]=useState(hackathons[0]?.id??0);const[title,setTitle]=useState('');const[details,setDetails]=useState('');const[error,setError]=useState('');const[done,setDone]=useState(false);const[pending,start]=useTransition();
  const submit=(e:React.FormEvent)=>{e.preventDefault();start(async()=>{setError('');const result=await requestBuilderEvent({hackathonId:id,title,details});if(result.ok){setDone(true);router.refresh();}else setError(result.error);});};
  if(done)return <p role='status'>Your event idea is with Superteam NL. We’ll be in touch.</p>;
  return <form className={styles.form} onSubmit={submit}><label className={styles.field}>Hackathon<select value={id} onChange={e=>setId(Number(e.target.value))}>{hackathons.map(h=><option key={h.id} value={h.id}>{h.name}</option>)}</select></label><label className={styles.field}>Event name<input value={title} onChange={e=>setTitle(e.target.value)} required minLength={3} maxLength={120}/></label><label className={styles.field}>What would you like to host?<textarea value={details} onChange={e=>setDetails(e.target.value)} required minLength={10} maxLength={3000}/></label><ErrorText error={error}/><button className={styles.button} disabled={pending}>Send your idea<Arrow/></button></form>;
}
