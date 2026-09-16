'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { IconArrowRight, IconTelegramLogo } from 'symbols-react';
import { acceptBuilderInvite, chooseBuilderPath, importBuilderTeam, previewBuilderImport, previewBuilderInvite, requestBuilderEvent } from '@/lib/hq/actions/builders';
import type { BuilderHackathon } from '@/lib/hq/builder-types';
import { SUPERTEAM_NL_TELEGRAM_GROUP, SUPERTEAM_NL_TELEGRAM_GROUP_LABEL } from '@/lib/hq/community';
import { fmtDateRange } from '@/lib/hq/hackathon-format';
import { parseJoinCode } from '@/lib/hq/member-routes';
import { BuilderImportHelp } from './builder-import-help';
import styles from './builder-shell.module.css';

function Arrow() { return <IconArrowRight width={20} height={20} fill='currentColor' aria-hidden='true'/>; }
function ErrorText({error}:{error:string}) { return error ? <p role='alert' className={styles.error}>{error}</p> : null; }

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
    {hackathons.length>1&&<label className={styles.field}>Your hackathon<select value={selected} onChange={e=>setSelected(Number(e.target.value))}>{hackathons.map(h=><option value={h.id} key={h.id}>{h.name}</option>)}</select></label>}
    <div className={styles.choices}>
      <button className={styles.choice} disabled={pending} onClick={()=>choose('initialize')}><span><strong>Import your team</strong><span>Use your Colosseum project link.</span></span><Arrow/></button>
      <button className={styles.choice} disabled={pending} onClick={()=>choose('join')}><span><strong>Join a team</strong><span>Use the join link a teammate sent you.</span></span><Arrow/></button>
    </div>
    <button className={styles.textButton} disabled={pending} onClick={()=>choose('supporter')}>I’m not building this time</button>
    <ErrorText error={error}/>
  </>;
}

type ImportPreview = {name:string;projectUrl:string;members:{username:string;name:string;avatarUrl:string|null}[]};
type InvitePreview = {team:string;projectUrl:string;code:string;joinedUrl?:string;members:{id:string;username:string;name:string;avatarUrl:string|null}[]};

function RosterHelp({projectUrl,pending,onRefresh,emptyMessage}:{projectUrl:string;pending:boolean;onRefresh:()=>void;emptyMessage?:string}) {
  const content = <>
    <p>Add yourself to the project on Colosseum, then refresh.</p>
    <div className={styles.actions}>
      <a className={styles.inlineLink} href={projectUrl} target='_blank' rel='noopener noreferrer'>Open Colosseum</a>
      <button type='button' className={styles.secondary} disabled={pending} onClick={onRefresh}>{pending?'Refreshing…':'Refresh team'}</button>
    </div>
  </>;
  return emptyMessage
    ? <section className={styles.notice}><p role='status'>{emptyMessage}</p>{content}</section>
    : <details className={styles.details}><summary>I’m not listed</summary>{content}</details>;
}

/** Preview the source, then let the importer identify their own teammate. */
export function BuilderInitialize({hackathon,available,telegramConnected=false}:{hackathon:BuilderHackathon;available:boolean;telegramConnected?:boolean}) {
  const router=useRouter();
  const [url,setUrl]=useState('');
  const [project,setProject]=useState<ImportPreview|null>(null);
  const identityField=useRef<HTMLSelectElement>(null);
  useEffect(()=>{if(project)identityField.current?.focus();},[project]);
  const [selectedUsername,setSelectedUsername]=useState('');
  const [failure,setFailure]=useState<{message:string;reason?:string}|null>(null);
  const [pending,start]=useTransition();
  const preview=()=>start(async()=>{
    setFailure(null);
    try {
      const result=await previewBuilderImport({hackathonId:hackathon.id,url});
      if(result.ok){setProject(result.data);setSelectedUsername('');}
      else setFailure({message:result.error,reason:'reason' in result?result.reason:undefined});
    } catch {setFailure({message:'Couldn’t check this project. Try again.'});}
  });
  const submit=(e:React.FormEvent)=>{e.preventDefault();start(async()=>{
    if(!project || !selectedUsername) return;
    setFailure(null);
    try {
      const result=await importBuilderTeam({hackathonId:hackathon.id,url:project.projectUrl,selectedUsername});
      if(result.ok)router.replace(result.data.url);
      else setFailure({message:result.error,reason:'reason' in result?result.reason:undefined});
    } catch {setFailure({message:'Couldn’t import this team. Try again.'});}
  });};
  return <>
    {!available
      ? <section className={styles.notice}><p>Project imports open at the start of the hackathon.</p><p>{fmtDateRange(hackathon.startDate,hackathon.endDate)}</p><Link className={styles.inlineLink} href='/hq/dashboard'>Go to my HQ</Link></section>
      : !project
        ? <>
          <p>Use the Colosseum project registered in the Netherlands for {hackathon.name}.</p>
          <form className={styles.form} aria-busy={pending} onSubmit={e=>{e.preventDefault();preview();}}>
            <label className={styles.field}>Colosseum project link<input type='url' value={url} onChange={e=>setUrl(e.target.value)} autoComplete='off' spellCheck={false} placeholder='https://colosseum.com/arena/projects/…' required maxLength={2048} disabled={pending}/></label>
            <button className={styles.button} disabled={pending}>{pending?'Checking…':'Continue'}<Arrow/></button>
          </form>
        </>
        : <>
          <p><strong>{project.name}</strong></p>
          {project.members.length>0 && <form className={styles.form} aria-busy={pending} onSubmit={submit}>
            <label className={styles.field}>Which teammate are you?<select ref={identityField} value={selectedUsername} onChange={e=>setSelectedUsername(e.target.value)} required disabled={pending}>
              <option value='' disabled>Select your name</option>
              {project.members.map(member=><option key={member.username} value={member.username}>{member.name} (@{member.username})</option>)}
            </select></label>
            <button className={styles.button} disabled={pending||!selectedUsername}>{pending?'Importing…':'Import team'}<Arrow/></button>
          </form>}
          <RosterHelp projectUrl={project.projectUrl} pending={pending} onRefresh={preview} emptyMessage={project.members.length?undefined:'No teammates found.'}/>
          <button type='button' className={styles.textButton} disabled={pending} onClick={()=>{setProject(null);setSelectedUsername('');setFailure(null);}}>Use another project</button>
        </>}
    {failure && <div className={styles.notice}>
      <p className={styles.error} role='alert'>{failure.message}</p>
      {failure.reason==='already_imported' && <TelegramGroupControl/>}
    </div>}
    <BuilderImportHelp hackathonId={hackathon.id} projectUrl={url} telegramConnected={telegramConnected} disabled={pending}/>
  </>;
}

/** One team link. Each person chooses an available Colosseum teammate. */
export function BuilderJoin({initialCode=''}:{initialCode?:string}) {
  const router=useRouter();
  const [pasted,setPasted]=useState(initialCode);
  const [memberId,setMemberId]=useState('');
  const [invite,setInvite]=useState<InvitePreview|null>(null);
  const identityField=useRef<HTMLSelectElement>(null);
  useEffect(()=>{if(invite)identityField.current?.focus();},[invite]);
  const [error,setError]=useState('');
  const [pending,start]=useTransition();
  const lookup=useCallback((value:string)=>start(async()=>{
    setError('');
    try {
      const result=await previewBuilderInvite(value);
      if(result.ok){
        if(result.data.joinedUrl){router.replace(result.data.joinedUrl);return;}
        setInvite(result.data);setMemberId('');
      }else setError(result.error);
    } catch {setError('Couldn’t check this link. Try again.');}
  }),[router,start]);
  // A clicked join link opens the teammate selection directly.
  useEffect(()=>{if(initialCode && parseJoinCode(initialCode))lookup(initialCode);},[initialCode,lookup]);
  const join=(e:React.FormEvent)=>{e.preventDefault();start(async()=>{
    if(!invite || !memberId)return;
    setError('');
    try {
      const result=await acceptBuilderInvite({code:invite.code,memberId});
      if(result.ok){router.replace(result.data.url);return;}
      setError(result.error);
      // A teammate may have claimed this name while the form was open.
      // Keep the original error and selection if this refresh cannot connect.
      const updated=await previewBuilderInvite(invite.code).catch(()=>null);
      if(updated?.ok){
        if(updated.data.joinedUrl){router.replace(updated.data.joinedUrl);return;}
        setInvite(updated.data);setMemberId('');
      }
    } catch {setError('Couldn’t join this team. Try again.');}
  });};
  return <>
    {!invite
      ? <form className={styles.form} aria-busy={pending} onSubmit={e=>{e.preventDefault();lookup(pasted);}}>
          <label className={styles.field}>Team join link<input value={pasted} onChange={e=>setPasted(e.target.value)} autoComplete='off' spellCheck={false} required maxLength={2048} placeholder='Paste your team’s link' disabled={pending}/></label>
          <button className={styles.button} disabled={pending}>{pending?'Checking…':'Continue'}<Arrow/></button>
        </form>
      : <>
          <p><strong>{invite.team}</strong></p>
          {invite.members.length>0 && <form className={styles.form} aria-busy={pending} onSubmit={join}>
            <label className={styles.field}>Which teammate are you?<select ref={identityField} value={memberId} onChange={e=>setMemberId(e.target.value)} required disabled={pending}>
              <option value='' disabled>Select your name</option>
              {invite.members.map(member=><option key={member.id} value={member.id}>{member.name} (@{member.username})</option>)}
            </select></label>
            <button className={styles.button} disabled={pending||!memberId}>{pending?'Joining…':'Join team'}<Arrow/></button>
          </form>}
          <RosterHelp projectUrl={invite.projectUrl} pending={pending} onRefresh={()=>lookup(invite.code)} emptyMessage={invite.members.length?undefined:'All teammates have joined.'}/>
          <button type='button' className={styles.textButton} disabled={pending} onClick={()=>{setInvite(null);setMemberId('');setError('');}}>Use another link</button>
        </>}
    <ErrorText error={error}/>
  </>;
}

export function BuilderHostApplication({hackathons}:{hackathons:BuilderHackathon[]}) {
  const router=useRouter();const[id,setId]=useState(hackathons[0]?.id??0);const[title,setTitle]=useState('');const[details,setDetails]=useState('');const[error,setError]=useState('');const[done,setDone]=useState(false);const[pending,start]=useTransition();
  const submit=(e:React.FormEvent)=>{e.preventDefault();start(async()=>{setError('');const result=await requestBuilderEvent({hackathonId:id,title,details});if(result.ok){setDone(true);router.refresh();}else setError(result.error);});};
  if(done)return <p role='status'>Your event idea is with Superteam NL. We’ll be in touch.</p>;
  return <form className={styles.form} onSubmit={submit}>{hackathons.length>1&&<label className={styles.field}>Hackathon<select value={id} onChange={e=>setId(Number(e.target.value))}>{hackathons.map(h=><option key={h.id} value={h.id}>{h.name}</option>)}</select></label>}<label className={styles.field}>Event name<input value={title} onChange={e=>setTitle(e.target.value)} required minLength={3} maxLength={120}/></label><label className={styles.field}>What would you like to host?<textarea value={details} onChange={e=>setDetails(e.target.value)} required minLength={10} maxLength={3000}/></label><ErrorText error={error}/><button className={styles.button} disabled={pending}>Send your idea<Arrow/></button></form>;
}
