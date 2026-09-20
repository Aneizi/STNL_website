'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { IconArrowRight } from 'symbols-react';
import { acceptBuilderInvite, importBuilderTeam, previewBuilderImport, previewBuilderInvite } from '@/lib/hq/actions/builders';
import { parseJoinCode } from '@/lib/hq/member-routes';
import { BuilderImportHelp } from './builder-import-help';
import styles from './builder-shell.module.css';

function Arrow() { return <IconArrowRight width={20} height={20} fill='currentColor' aria-hidden='true'/>; }
function ErrorText({error}:{error:string}) { return error ? <p role='alert' className={styles.error}>{error}</p> : null; }

/**
 * The two ways in, as plain links: nothing is written or checked before the
 * member has chosen, and the Initialize page validates the edition itself.
 * Without an open edition the Initialize link carries no edition and that
 * page answers with its own not-found. Not building is just Home.
 */
export function BuilderWelcome({hackathonId}:{hackathonId:number|null}) {
  return <>
    <div className={styles.choices}>
      <Link className={styles.choice} href={hackathonId===null?'/hq/initialize':`/hq/initialize?hackathon=${hackathonId}`}><span><strong>Import your team</strong><span>Use your Colosseum project link.</span></span><Arrow/></Link>
      <Link className={styles.choice} href='/hq/join'><span><strong>Join a team</strong><span>Use the join link a teammate sent you.</span></span><Arrow/></Link>
    </div>
    <Link className={styles.textLink} href='/hq/dashboard'>I’m not building this time</Link>
  </>;
}

type ImportPreview = {name:string;projectUrl:string;members:{username:string;name:string;avatarUrl:string|null}[]};
type InvitePreview = {team:string;projectUrl:string;code:string;joinedUrl?:string;members:{id:string;username:string;name:string;avatarUrl:string|null}[]};

/** The way onto the roster for someone Colosseum does not list yet: the project itself, then a fresh read of it. */
function RosterHelp({projectUrl,pending,onRefresh}:{projectUrl:string;pending:boolean;onRefresh:()=>void}) {
  return <details className={styles.details}>
    <summary>I’m not listed</summary>
    <p>Add yourself to the project on Colosseum, then refresh.</p>
    <div className={styles.actions}>
      <a className={styles.inlineLink} href={projectUrl} target='_blank' rel='noopener noreferrer'>Open Colosseum</a>
      <button type='button' className={styles.secondary} disabled={pending} onClick={onRefresh}>{pending?'Refreshing…':'Refresh team'}</button>
    </div>
  </details>;
}

/** The shape every Colosseum project link has; anything else is refused before a request is made. The server parses the link again. */
const COLOSSEUM_PROJECT_LINK = /colosseum\.com\/arena\/projects\//;

/** Preview the source, then let the importer identify their own teammate. */
export function BuilderInitialize({hackathonId}:{hackathonId:number}) {
  const router=useRouter();
  const [url,setUrl]=useState('');
  const [project,setProject]=useState<ImportPreview|null>(null);
  const identityField=useRef<HTMLSelectElement>(null);
  useEffect(()=>{if(project)identityField.current?.focus();},[project]);
  const [selectedUsername,setSelectedUsername]=useState('');
  const [error,setError]=useState('');
  const [pending,start]=useTransition();
  const preview=()=>{
    if(!COLOSSEUM_PROJECT_LINK.test(url)){setError('That doesn’t look like a Colosseum project link.');return;}
    start(async()=>{
      setError('');
      try {
        const result=await previewBuilderImport({hackathonId,url});
        if(result.ok){setProject(result.data);setSelectedUsername('');}
        else setError(result.error);
      } catch {setError('Couldn’t check this project. Try again.');}
    });
  };
  const submit=(e:React.FormEvent)=>{e.preventDefault();start(async()=>{
    if(!project || !selectedUsername) return;
    setError('');
    try {
      const result=await importBuilderTeam({hackathonId,url:project.projectUrl,selectedUsername});
      if(result.ok)router.replace('/hq/dashboard');
      else setError(result.error);
    } catch {setError('Couldn’t import this team. Try again.');}
  });};
  return <>
    {!project
      ? <>
        <p>Use the Colosseum project registered in the Netherlands for Colosseum Crypto World&apos;s Fair.</p>
        <form className={styles.form} aria-busy={pending} onSubmit={e=>{e.preventDefault();preview();}}>
          <label className={styles.field}>Colosseum project link<input type='url' value={url} onChange={e=>setUrl(e.target.value)} autoComplete='off' spellCheck={false} placeholder='https://colosseum.com/arena/projects/…' required maxLength={2048} disabled={pending}/></label>
          <button type='submit' className={styles.button} disabled={pending}>{pending?'Checking…':'Continue'}<Arrow/></button>
        </form>
      </>
      : <>
        <p><strong>{project.name}</strong></p>
        <form className={styles.form} aria-busy={pending} onSubmit={submit}>
          <label className={styles.field}>Which teammate are you?<select ref={identityField} value={selectedUsername} onChange={e=>setSelectedUsername(e.target.value)} required disabled={pending}>
            <option value='' disabled>Select your name</option>
            {project.members.map(member=><option key={member.username} value={member.username}>{member.name} (@{member.username})</option>)}
          </select></label>
          <button type='submit' className={styles.button} disabled={pending||!selectedUsername}>{pending?'Importing…':'Import team'}<Arrow/></button>
        </form>
        <RosterHelp projectUrl={project.projectUrl} pending={pending} onRefresh={preview}/>
        <button type='button' className={styles.textButton} onClick={()=>{setProject(null);setSelectedUsername('');setError('');}}>Use another project</button>
      </>}
    {error && <div className={styles.notice}><p className={styles.error} role='alert'>{error}</p></div>}
    <BuilderImportHelp hackathonId={hackathonId} url={url} onUrl={setUrl}/>
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
  const lookup=useCallback((value:string)=>{
    if(!value.trim())return;
    start(async()=>{
      setError('');
      try {
        const result=await previewBuilderInvite(value);
        if(result.ok){
          if(result.data.joinedUrl){router.replace(result.data.joinedUrl);return;}
          setInvite(result.data);setMemberId('');
        }else setError(result.error);
      } catch {setError('Couldn’t check this link. Try again.');}
    });
  },[router,start]);
  // A clicked join link opens the teammate selection directly.
  useEffect(()=>{if(initialCode && parseJoinCode(initialCode))lookup(initialCode);},[initialCode,lookup]);
  const join=(e:React.FormEvent)=>{e.preventDefault();start(async()=>{
    if(!invite || !memberId)return;
    setError('');
    try {
      const result=await acceptBuilderInvite({code:invite.code,memberId});
      if(result.ok){router.replace('/hq/dashboard');return;}
      setError(result.error);
      // A teammate may have claimed this name while the form was open.
      // Keep the original error and selection if this refresh cannot connect.
      const updated=await previewBuilderInvite(invite.code).catch(()=>null);
      if(updated?.ok){
        if(updated.data.joinedUrl){router.replace('/hq/dashboard');return;}
        setInvite(updated.data);setMemberId('');
      }
    } catch {setError('Couldn’t join this team. Try again.');}
  });};
  return <>
    {!invite
      ? <>
        <p>Paste your team’s join link.</p>
        <form className={styles.form} aria-busy={pending} onSubmit={e=>{e.preventDefault();lookup(pasted);}}>
          <label className={styles.field}>Team join link<input value={pasted} onChange={e=>setPasted(e.target.value)} autoComplete='off' spellCheck={false} required maxLength={2048} placeholder='Paste your team’s link' disabled={pending}/></label>
          <button type='submit' className={styles.button} disabled={pending}>{pending?'Checking…':'Continue'}<Arrow/></button>
        </form>
      </>
      : <>
        <p><strong>{invite.team}</strong></p>
        <form className={styles.form} aria-busy={pending} onSubmit={join}>
          <label className={styles.field}>Which teammate are you?<select ref={identityField} value={memberId} onChange={e=>setMemberId(e.target.value)} required disabled={pending}>
            <option value='' disabled>Select your name</option>
            {invite.members.map(member=><option key={member.id} value={member.id}>{member.name} (@{member.username})</option>)}
          </select></label>
          <button type='submit' className={styles.button} disabled={pending||!memberId}>{pending?'Joining…':'Join team'}<Arrow/></button>
        </form>
        <RosterHelp projectUrl={invite.projectUrl} pending={pending} onRefresh={()=>lookup(invite.code)}/>
        <button type='button' className={styles.textButton} onClick={()=>{setInvite(null);setMemberId('');setError('');}}>Use another link</button>
      </>}
    <ErrorText error={error}/>
  </>;
}
