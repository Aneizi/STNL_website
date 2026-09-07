'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { IconArrowRight } from 'symbols-react';
import { chooseBuilderPath, previewBuilderProject, beginBuilderVerification, completeBuilderImport, requestBuilderReview, previewBuilderInvite, acceptBuilderInvite, createBuilderInvite, saveBuilderTeam, requestBuilderEvent } from '@/lib/hq/actions/builders';
import { PROJECT_STAGES, type BuilderHackathon, type BuilderTeam } from '@/lib/hq/builder-types';
import { fmtDateRange } from '@/lib/hq/hackathon-format';
import styles from './builder-shell.module.css';

function Arrow() { return <IconArrowRight width={20} height={20} fill='currentColor' aria-hidden='true'/>; }
function ErrorText({error}:{error:string}) { return error ? <p role='alert' className={styles.error}>{error}</p> : null; }
function StageField({value,onChange}:{value:string;onChange:(value:string)=>void}) { return <label className={styles.field}>Where is your project today?<select value={value} onChange={e=>onChange(e.target.value)}>{PROJECT_STAGES.map(s=><option key={s.value} value={s.value}>{s.label}</option>)}</select></label>; }

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
      <button className={styles.choice} disabled={pending} onClick={()=>choose('initialize')}><span><strong>Initialize your team</strong><span>Import your project and teammates from Colosseum.</span></span><Arrow/></button>
      <button className={styles.choice} disabled={pending} onClick={()=>choose('join')}><span><strong>Join a team</strong><span>Use the invite code your team shared with you.</span></span><Arrow/></button>
    </div>
    <button className={styles.textButton} disabled={pending} onClick={()=>choose('supporter')}>I’m not building this time</button>
    <ErrorText error={error}/>
  </>;
}

type Preview = {name:string;url:string;country:string|null;members:{username:string;name:string}[]};
export function BuilderInitialize({hackathon,available}:{hackathon:BuilderHackathon;available:boolean}) {
  const router=useRouter();
  const [url,setUrl]=useState('');
  const [preview,setPreview]=useState<Preview|null>(null);
  const [username,setUsername]=useState('');
  const [lead,setLead]=useState('');
  const [stage,setStage]=useState('idea');
  const [challenge,setChallenge]=useState<{id:string;code:string}|null>(null);
  const [note,setNote]=useState('');
  const [error,setError]=useState('');
  const [pending,start]=useTransition();
  const lookup=(e:React.FormEvent)=>{e.preventDefault();start(async()=>{setError('');const result=await previewBuilderProject({hackathonId:hackathon.id,url});if(result.ok){setPreview(result.data);setLead(result.data.members[0]?.username??'');}else setError(result.error);});};
  const identify=(e:React.FormEvent)=>{e.preventDefault();start(async()=>{setError('');const result=await beginBuilderVerification({hackathonId:hackathon.id,url:preview!.url,username});if(result.ok)setChallenge(result.data);else setError(result.error);});};
  const finish=(manual:boolean)=>start(async()=>{setError('');const result=await completeBuilderImport({challengeId:challenge!.id,leadUsername:lead,stage,manual});if(result.ok)router.replace(result.data.url);else setError(result.error);});
  const review=(e:React.FormEvent)=>{e.preventDefault();start(async()=>{setError('');const result=await requestBuilderReview({hackathonId:hackathon.id,url,note});if(result.ok)router.replace(result.data.url);else setError(result.error);});};
  return <>
    {!available ? <section className={styles.notice}><h2>Your account is ready.</h2><p>Colosseum project access opens at the start of the hackathon. Come back then to import your team.</p><p>{fmtDateRange(hackathon.startDate,hackathon.endDate)}</p><Link className={styles.inlineLink} href='/hq/dashboard'>Go to my HQ</Link></section> : <p>Your team starts on Colosseum. Paste its project link here to bring it into HQ.</p>}
    {available && !preview && <form className={styles.form} onSubmit={lookup}><label className={styles.field}>Colosseum project link<input type='url' value={url} onChange={e=>setUrl(e.target.value)} placeholder='https://colosseum.com/arena/projects/explore/…' required maxLength={400}/></label><button className={styles.button} disabled={pending}>{pending?'Loading project…':'Find my project'}<Arrow/></button></form>}
    {preview && <section className={styles.notice}><h2>{preview.name}</h2><p>{preview.members.map(m=>m.name).join(', ')}</p><p>Registered under <strong>{preview.country||'No country selected'}</strong>.</p>{preview.country?.toLowerCase()!=='netherlands'&&<p className={styles.error}>Choose Netherlands on your Colosseum project before verification.</p>}</section>}
    {preview && !challenge && <form className={styles.form} onSubmit={identify}><label className={styles.field}>Which teammate are you?<select required value={username} onChange={e=>setUsername(e.target.value)}><option value=''>Choose your Colosseum profile</option>{preview.members.map(m=><option key={m.username} value={m.username}>{m.name} (@{m.username})</option>)}</select></label><button className={styles.button} disabled={pending}>{pending?'Preparing…':'Get verification code'}<Arrow/></button><button type='button' className={styles.textButton} onClick={()=>{setPreview(null);setError('');}}>Use a different project</button></form>}
    {preview && challenge && <div className={styles.form}>
      <div><h2>One quick check</h2><p>Post this number as a comment on your Colosseum project, signed in as <strong>@{username}</strong>. The code expires in 30 minutes.</p><output className={styles.code}>{challenge.code}</output><a className={styles.inlineLink} href={preview.url} target='_blank' rel='noopener noreferrer'>Open project to post the code</a></div>
      <label className={styles.field}>Who’s the lead?<select value={lead} onChange={e=>setLead(e.target.value)}>{preview.members.map(m=><option key={m.username} value={m.username}>{m.name}</option>)}</select></label>
      <StageField value={stage} onChange={setStage}/>
      <button className={styles.button} disabled={pending} onClick={()=>finish(false)}>{pending?'Checking…':'I’ve posted the code'}<Arrow/></button>
      <button className={styles.textButton} disabled={pending} onClick={()=>finish(true)}>Ask Superteam NL to verify me instead</button>
      <p>With manual review, your dashboard opens with “Awaiting approval”. Team invites become available after approval.</p>
      <button className={styles.textButton} disabled={pending} onClick={()=>{setChallenge(null);setError('');}}>Get a fresh code</button>
    </div>}
    <ErrorText error={error}/>
    <details className={styles.details}><summary>Can’t access your Colosseum project?</summary><p>Share its link and what went wrong. We’ll review it in HQ.</p><form className={styles.form} onSubmit={review}><label className={styles.field}>Project link<input type='url' value={url} onChange={e=>setUrl(e.target.value)} required maxLength={400}/></label><label className={styles.field}>How can we help?<textarea value={note} onChange={e=>setNote(e.target.value)} minLength={5} maxLength={1500} required/></label><button className={styles.secondary} disabled={pending}>Request a review</button></form></details>
  </>;
}

export function BuilderJoin() {
  const router=useRouter(); const [code,setCode]=useState('');const[confirmed,setConfirmed]=useState(false);
  const[invite,setInvite]=useState<{name:string;username:string;team:string}|null>(null); const[error,setError]=useState('');const[pending,start]=useTransition();
  const lookup=(e:React.FormEvent)=>{e.preventDefault();start(async()=>{setError('');const result=await previewBuilderInvite(code);if(result.ok)setInvite(result.data);else setError(result.error);});};
  const join=(e:React.FormEvent)=>{e.preventDefault();start(async()=>{setError('');const result=await acceptBuilderInvite({code,confirmed});if(result.ok)router.replace(result.data.url);else setError(result.error);});};
  return <>{!invite?<form className={styles.form} onSubmit={lookup}><label className={styles.field}>Your invite code<input value={code} onChange={e=>setCode(e.target.value)} autoCapitalize='characters' autoComplete='off' required maxLength={40}/></label><button className={styles.button} disabled={pending}>{pending?'Checking…':'Find my team'}<Arrow/></button></form>:<form className={styles.form} onSubmit={join}><section className={styles.notice}><h2>{invite.team}</h2><p>This invitation is for <strong>{invite.name}</strong>, @{invite.username} on Colosseum.</p></section><label className={styles.check}>That’s me<input type='checkbox' required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/></label><button className={styles.button} disabled={pending||!confirmed}>{pending?'Joining…':'Join team'}<Arrow/></button><button type='button' className={styles.textButton} onClick={()=>{setInvite(null);setConfirmed(false);setError('');}}>Use another code</button></form>}<ErrorText error={error}/></>;
}

export function BuilderTeamControls({team,isOwner}:{team:BuilderTeam;isOwner:boolean}) {
  const router=useRouter();const[stage,setStage]=useState<string>(team.stage);const[lead,setLead]=useState(team.leadUsername);const[error,setError]=useState('');const[message,setMessage]=useState('');const[invite,setInvite]=useState<{name:string;code:string}|null>(null);const[pending,start]=useTransition();
  const save=(e:React.FormEvent)=>{e.preventDefault();start(async()=>{setError('');setMessage('');const result=await saveBuilderTeam({projectId:team.id,stage,leadUsername:lead});if(result.ok){setMessage('Saved.');router.refresh();}else setError(result.error);});};
  const create=(memberId:string,name:string)=>start(async()=>{setError('');const result=await createBuilderInvite({projectId:team.id,memberId});if(result.ok)setInvite({name,code:result.data.code});else setError(result.error);});
  return <><section className={styles.card}><h2>Your team</h2>{team.members.map(m=><div className={styles.row} key={m.id}><div>{m.name}{m.username===team.leadUsername?' (lead)':''}<small>@{m.username}</small></div>{m.joined?<span>Joined</span>:isOwner&&team.verification==='verified'?<button className={styles.secondary} disabled={pending} onClick={()=>create(m.id,m.name)}>Invite</button>:<span>Not joined</span>}</div>)}</section>
    {invite&&<section className={styles.notice} aria-live='polite'><h2>Invite {invite.name}</h2><p>Share this code privately with {invite.name}. It works once and expires in 48 hours.</p><output className={styles.code}>{invite.code}</output><p>They can enter it at <Link className={styles.inlineLink} href='/hq/join'>Join a team</Link>.</p></section>}
    {isOwner&&team.verification!=='rejected'&&<form className={styles.form} onSubmit={save}><StageField value={stage} onChange={setStage}/><label className={styles.field}>Team lead<select value={lead} onChange={e=>setLead(e.target.value)}>{team.members.map(m=><option key={m.id} value={m.username}>{m.name}</option>)}</select></label><button className={styles.secondary} disabled={pending}>Save changes</button></form>}
    <ErrorText error={error}/>{message&&<p role='status' className={styles.success}>{message}</p>}
  </>;
}

export function BuilderHostApplication({hackathons}:{hackathons:BuilderHackathon[]}) {
  const router=useRouter();const[id,setId]=useState(hackathons[0]?.id??0);const[title,setTitle]=useState('');const[details,setDetails]=useState('');const[error,setError]=useState('');const[done,setDone]=useState(false);const[pending,start]=useTransition();
  const submit=(e:React.FormEvent)=>{e.preventDefault();start(async()=>{setError('');const result=await requestBuilderEvent({hackathonId:id,title,details});if(result.ok){setDone(true);router.refresh();}else setError(result.error);});};
  if(done)return <p role='status'>Your event idea is with Superteam NL. We’ll be in touch.</p>;
  return <form className={styles.form} onSubmit={submit}><label className={styles.field}>Hackathon<select value={id} onChange={e=>setId(Number(e.target.value))}>{hackathons.map(h=><option key={h.id} value={h.id}>{h.name}</option>)}</select></label><label className={styles.field}>Event name<input value={title} onChange={e=>setTitle(e.target.value)} required minLength={3} maxLength={120}/></label><label className={styles.field}>What would you like to host?<textarea value={details} onChange={e=>setDetails(e.target.value)} required minLength={10} maxLength={3000}/></label><ErrorText error={error}/><button className={styles.button} disabled={pending}>Send your idea<Arrow/></button></form>;
}
