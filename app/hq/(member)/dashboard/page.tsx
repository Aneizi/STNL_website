import type { Metadata } from 'next';
import { BuilderShell } from '@/components/hq/builder-shell';
import { MenuGrid, MenuTile } from '@/components/hq/builder-menu';
import { requireMemberActor } from '@/lib/hq/actor';
import { builderStore } from '@/lib/hq/builder-store';
import { projectNeedsAttention } from '@/lib/hq/dashboard-attention';
import { nowMs, todayInTz } from '@/lib/hq/format';
import { isLive } from '@/lib/hq/hackathon-format';
import { memberWeekSummaries } from '@/lib/hq/reporting-surface';
import { LINKS } from '@/lib/links';
export const metadata:Metadata={title:'Home'};
export const dynamic='force-dynamic';
export default async function DashboardPage(){
  const actor=await requireMemberActor('/hq/dashboard');
  const at=nowMs();
  const store=builderStore();
  const [teams,ownProjects,dashboard,hackathons]=await Promise.all([store.teams(actor.id),store.ownedProjects(actor.id),store.dashboard(actor.id),store.hackathons()]);
  const projects=[...teams.filter(team=>team.verification==='verified'),...ownProjects];
  const weeks=await memberWeekSummaries(projects,undefined,at);
  const today=todayInTz('Europe/Amsterdam');
  const enrolled=new Set(dashboard.enrollments.map(row=>Number(row.hackathon_id)));
  const editions=new Map<number,string>();
  // New choices are limited to running editions. Existing participation stays
  // reachable after an edition ends, including archived projects.
  for(const hackathon of hackathons) {
    if(isLive(hackathon,today)||enrolled.has(hackathon.id)) editions.set(hackathon.id,hackathon.name);
  }
  for(const project of projects) editions.set(project.hackathonId,project.hackathonName);
  for(const request of dashboard.requests) editions.set(Number(request.hackathon_id),String(request.name));
  for(const event of dashboard.events) editions.set(Number(event.hackathon_id),String(event.name));

  return <BuilderShell fullWidth><h1>Home</h1>
    <MenuGrid>
      {[...editions].map(([id,name])=>{
        const editionProjects=projects.filter(project=>project.hackathonId===id);
        const hasRequests=dashboard.requests.some(request=>Number(request.hackathon_id)===id);
        const hasHosting=dashboard.events.some(event=>Number(event.hackathon_id)===id)||(dashboard.tier==='member'&&hackathons.some(h=>h.id===id&&h.hostingEnabled&&enrolled.has(id)));
        const href=editionProjects.length===1&&!hasRequests&&!hasHosting?`/hq/team/${editionProjects[0].id}`:`/hq/hackathon/${id}`;
        return <MenuTile key={id} href={href} label={name} needsAttention={weeks.some(week=>week.hackathonId===id&&projectNeedsAttention(week,at))}/>;
      })}
      {actor.capabilities.has('captain')&&<MenuTile href='/hq/captain' label='Captain'/>}
      <MenuTile href='/hq/account' label='Account'/>
      <MenuTile href={LINKS.telegram} label='Get help' external/>
    </MenuGrid>
  </BuilderShell>;
}
