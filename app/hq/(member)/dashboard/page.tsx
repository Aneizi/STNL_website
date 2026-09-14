import type { Metadata } from 'next';
import Link from 'next/link';
import { BuilderShell } from '@/components/hq/builder-shell';
import { BuilderHostApplication } from '@/components/hq/builder-onboarding';
import styles from '@/components/hq/builder-shell.module.css';
import { requireMemberActor } from '@/lib/hq/actor';
import { builderStore } from '@/lib/hq/builder-store';
import { LINKS } from '@/lib/links';
export const metadata:Metadata={title:'Your HQ'};
export const dynamic='force-dynamic';
export default async function DashboardPage(){
  const actor=await requireMemberActor('/hq/dashboard');
  const store=builderStore();
  const [teams,dashboard,hackathons]=await Promise.all([store.teams(actor.id),store.dashboard(actor.id),store.hackathons()]);
  const hostable=hackathons.filter(h=>h.hostingEnabled&&dashboard.enrollments.some(e=>Number(e.hackathon_id)===h.id));
  return <BuilderShell><h1>Your home for <em>building.</em></h1><p>Welcome, {actor.name}.</p>
    {teams.length===0&&<section className={styles.notice}><h2>You’re in.</h2><p>Initialize your team when your project is available on Colosseum, or join with an invite code.</p><Link className={styles.button} href='/hq/welcome'>Find your team</Link></section>}
    {teams.map(team=><section key={team.id} className={styles.card}><span className={styles.status}>{team.verification==='verified'?'Verified':team.verification==='pending'?'Awaiting approval':'Changes needed'}</span><h2>{team.name}</h2><p>{team.hackathonName}</p><Link href={`/hq/team/${team.id}`} className={styles.button}>Open team</Link></section>)}
    {dashboard.requests.map(request=><section key={String(request.id)} className={styles.card}><h2>{request.status==='pending'?'Awaiting approval':'Review completed'}</h2><p>Your project access request for {String(request.name)} is {request.status==='pending'?'with Superteam NL.':'resolved.'}</p><a className={styles.inlineLink} href={String(request.project_url)} target='_blank' rel='noopener noreferrer'>View Colosseum project</a></section>)}
    {teams.length>0&&<p><Link className={styles.inlineLink} href='/hq/welcome'>Take part in another hackathon</Link></p>}
    {dashboard.tier==='member'&&<section className={styles.card}><h2>Host an event</h2>{hostable.length?<BuilderHostApplication hackathons={hostable}/>:<p>Event applications are not open yet.</p>}{dashboard.events.map(event=><p key={String(event.id)}>{String(event.title)}: {String(event.status)}</p>)}</section>}
    {/* The linked identity decides this, not the sign-in method used today: a Telegram-only account always has one. */}
    {!actor.telegram&&<section className={styles.card} aria-labelledby='dashboard-telegram'><h2 id='dashboard-telegram'>Connect Telegram</h2><p>Sign in with Telegram as well as with your email. Connecting is optional and never changes your account, your teams or your roles.</p><Link className={styles.button} href='/hq/account'>Connect Telegram</Link></section>}
    <section className={styles.card}><h2>Need a hand?</h2><a className={styles.inlineLink} href={LINKS.telegram} target='_blank' rel='noopener noreferrer'>Talk to Superteam NL</a></section>
  </BuilderShell>;
}
