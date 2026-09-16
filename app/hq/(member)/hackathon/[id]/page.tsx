import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BuilderShell } from '@/components/hq/builder-shell';
import { MenuGrid, MenuTile } from '@/components/hq/builder-menu';
import { BuilderHostApplication, BuilderWelcome } from '@/components/hq/builder-onboarding';
import styles from '@/components/hq/builder-shell.module.css';
import { requireMemberActor } from '@/lib/hq/actor';
import { builderStore } from '@/lib/hq/builder-store';
import { projectNeedsAttention } from '@/lib/hq/dashboard-attention';
import { nowMs, todayInTz } from '@/lib/hq/format';
import { isLive } from '@/lib/hq/hackathon-format';
import { memberWeekSummaries } from '@/lib/hq/reporting-surface';

export const metadata:Metadata={title:'Your hackathon'};
export const dynamic='force-dynamic';

export default async function HackathonPage({params}:{params:Promise<{id:string}>}) {
  const {id}=await params;
  const actor=await requireMemberActor(`/hq/hackathon/${encodeURIComponent(id)}`);
  const hackathonId=Number(id);
  if(!/^[1-9]\d*$/.test(id)||!Number.isSafeInteger(hackathonId))notFound();
  const store=builderStore();
  const [teams,ownedProjects,dashboard,hackathons]=await Promise.all([
    store.teams(actor.id),store.ownedProjects(actor.id),store.dashboard(actor.id),store.hackathons(),
  ]);
  const hackathon=hackathons.find(item=>item.id===hackathonId);
  const projects=[
    ...teams.filter(team=>team.hackathonId===hackathonId&&team.verification==='verified'),
    ...ownedProjects.filter(project=>project.hackathonId===hackathonId),
  ];
  const requests=dashboard.requests.filter(request=>Number(request.hackathon_id)===hackathonId);
  const events=dashboard.events.filter(event=>Number(event.hackathon_id)===hackathonId);
  const hackathonName=hackathon?.name??projects[0]?.hackathonName??requests[0]?.name??events[0]?.name;
  if(!hackathonName)notFound();
  const today=todayInTz('Europe/Amsterdam');
  const live=hackathon?isLive(hackathon,today):false;
  const at=nowMs();
  const weeks=await memberWeekSummaries(projects,undefined,at);
  const canHost=dashboard.tier==='member'&&hackathon?.hostingEnabled&&dashboard.enrollments.some(item=>Number(item.hackathon_id)===hackathonId);

  return <BuilderShell fullWidth back='/hq/dashboard'>
    <h1>{String(hackathonName)}</h1>
    {projects.length>0&&<MenuGrid label="Your teams">{projects.map(project=><MenuTile key={project.id} href={`/hq/team/${project.id}`} label={project.name} needsAttention={projectNeedsAttention(weeks.find(week=>week.projectId===project.id),at)}/>)}</MenuGrid>}
    {projects.length===0&&live&&hackathon&&<BuilderWelcome hackathons={[hackathon]}/>}
    {projects.length===0&&!live&&!requests.length&&!events.length&&<p>{hackathon&&hackathon.startDate>today?'This hackathon hasn’t started yet.':'This hackathon has ended.'}</p>}
    {requests.length>0&&<details className={styles.details}>
      <summary>Help requests</summary>
      {requests.map(request=><p key={String(request.id)}><a className={styles.inlineLink} href={String(request.project_url)} target='_blank' rel='noopener noreferrer'>View Colosseum project</a>: {request.status==='pending'?'Pending':'Resolved'}</p>)}
    </details>}
    {(canHost||events.length>0)&&<details className={styles.details}>
      <summary>Host an event</summary>
      {canHost&&hackathon&&<BuilderHostApplication hackathons={[hackathon]}/>}
      {events.map(event=><p key={String(event.id)}>{String(event.title)}: {event.status==='approved'?'Approved':event.status==='declined'?'Declined':'Pending'}</p>)}
    </details>}
  </BuilderShell>;
}
