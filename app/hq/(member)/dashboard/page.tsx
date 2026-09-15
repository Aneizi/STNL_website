import type { Metadata } from 'next';
import Link from 'next/link';
import { BuilderShell } from '@/components/hq/builder-shell';
import { BuilderHostApplication } from '@/components/hq/builder-onboarding';
import { DashboardWeek } from '@/components/hq/reporting-dashboard';
import styles from '@/components/hq/builder-shell.module.css';
import { requireMemberActor } from '@/lib/hq/actor';
import { builderStore } from '@/lib/hq/builder-store';
import { nowMs } from '@/lib/hq/format';
import { memberWeekSummaries } from '@/lib/hq/reporting-surface';
import { LINKS } from '@/lib/links';
export const metadata:Metadata={title:'Your HQ'};
export const dynamic='force-dynamic';
export default async function DashboardPage(){
  const actor=await requireMemberActor('/hq/dashboard');
  const store=builderStore();
  const [teams,ownProjects,dashboard,hackathons]=await Promise.all([store.teams(actor.id),store.ownedProjects(actor.id),store.dashboard(actor.id),store.hackathons()]);
  const hostable=hackathons.filter(h=>h.hostingEnabled&&dashboard.enrollments.some(e=>Number(e.hackathon_id)===h.id));
  // The weekly update the plan's login experience asks for, said where people
  // land rather than only on the team screen they may never open. Read for
  // every project this account belongs to, verified teams and hand-created
  // projects alike, in one grouped query per edition.
  const weeks=await memberWeekSummaries([
    ...teams.filter(t=>t.verification==='verified').map(t=>({id:t.id,name:t.name,hackathonId:t.hackathonId})),
    ...ownProjects.map(p=>({id:p.id,name:p.name,hackathonId:p.hackathonId})),
  ]);
  const at=nowMs();
  return <BuilderShell><h1>Your home for <em>building.</em></h1><p>Welcome, {actor.name}.</p>
    {weeks.map(summary=><DashboardWeek key={summary.projectId} summary={summary} nowMs={at}/>)}
    {teams.length===0&&ownProjects.length===0&&<section className={styles.notice}><h2>You’re in.</h2><p>Initialize your team when your project is available on Colosseum, or join with an invite code.</p><Link className={styles.button} href='/hq/welcome'>Find your team</Link></section>}
    {teams.map(team=><section key={team.id} className={styles.card}><span className={styles.status}>{team.verification==='verified'?'Verified':team.verification==='pending'?'Awaiting approval':'Changes needed'}</span><h2>{team.name}</h2><p>{team.hackathonName}</p><Link href={`/hq/team/${team.id}`} className={styles.button}>Open team</Link></section>)}
    {/* A project Superteam NL created by hand from a Request help submission:
        no Colosseum snapshot, so no verification badge to show, and the same
        team page behind it. */}
    {ownProjects.map(project=><section key={project.id} className={styles.card}><span className={styles.status}>Set up by Superteam NL</span><h2>{project.name}</h2><p>{project.hackathonName}</p><Link href={`/hq/team/${project.id}`} className={styles.button}>Open team</Link></section>)}
    {dashboard.requests.map(request=><section key={String(request.id)} className={styles.card}><h2>{request.status==='pending'?'Awaiting approval':'Review completed'}</h2><p>Your project access request for {String(request.name)} is {request.status==='pending'?'with Superteam NL.':'resolved.'}</p><a className={styles.inlineLink} href={String(request.project_url)} target='_blank' rel='noopener noreferrer'>View Colosseum project</a></section>)}
    {(teams.length>0||ownProjects.length>0)&&<p><Link className={styles.inlineLink} href='/hq/welcome'>Take part in another hackathon</Link></p>}
    {dashboard.tier==='member'&&<section className={styles.card}><h2>Host an event</h2>{hostable.length?<BuilderHostApplication hackathons={hostable}/>:<p>Event applications are not open yet.</p>}{dashboard.events.map(event=><p key={String(event.id)}>{String(event.title)}: {String(event.status)}</p>)}</section>}
    {/* The linked identity decides this, not the sign-in method used today: a Telegram-only account always has one. */}
    {!actor.telegram&&<section className={styles.card} aria-labelledby='dashboard-telegram'><h2 id='dashboard-telegram'>Connect Telegram</h2><p>Sign in with Telegram as well as with your email. Connecting is optional and never changes your account, your teams or your roles.</p><Link className={styles.button} href='/hq/account'>Connect Telegram</Link></section>}
    <section className={styles.card}><h2>Need a hand?</h2><a className={styles.inlineLink} href={LINKS.telegram} target='_blank' rel='noopener noreferrer'>Talk to Superteam NL</a></section>
  </BuilderShell>;
}
