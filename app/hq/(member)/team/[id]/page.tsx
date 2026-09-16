import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BuilderShell } from '@/components/hq/builder-shell';
import { TeamWorkspace } from '@/components/hq/team-workspace';
import { TeamReporting } from '@/components/hq/reporting-member';
import { requireMemberActor } from '@/lib/hq/actor';
import { nowMs } from '@/lib/hq/format';
import { memberProjectView, memberTeamView } from '@/lib/hq/member-teams';
import { teamReportingPanel } from '@/lib/hq/reporting-surface';
export const metadata:Metadata={title:'Your team'};
export const dynamic='force-dynamic';
export default async function TeamPage({params}:{params:Promise<{id:string}>}){
  const {id}=await params;
  // One request instant for the whole page: the week, the final period and
  // the Monday/Tuesday prompt all answer to the same moment.
  const at=nowMs();
  const actor=await requireMemberActor(`/hq/team/${encodeURIComponent(id)}`);
  // The central decision, then the member's view and nothing wider. Every denial is this same not-found page.
  const team=await memberTeamView(actor,id);
  // A project an operator created from a Request help submission has no
  // Colosseum snapshot, so there is no BuilderTeam to build a team view from
  // and `memberTeamView` answers null. It is still this account's project,
  // with the same weekly reporting and the same Captain, so it gets the same
  // page with the imported half left out rather than a not-found.
  if(!team){
    const project=await memberProjectView(actor,id);
    if(!project)notFound();
    const panel=await teamReportingPanel(actor,{projectId:project.id,hackathonId:project.edition.id,atMs:at});
    return <BuilderShell fullWidth back='/hq/dashboard'>
      <TeamWorkspace project={project}>
        <TeamReporting panel={panel} teamName={project.name} isLead={project.membership.role==='owner'} nowMs={at} variant='dashboard'/>
      </TeamWorkspace>
    </BuilderShell>;
  }
  const panel=await teamReportingPanel(actor,{projectId:team.id,hackathonId:team.edition.id,atMs:at});
  return <BuilderShell fullWidth back='/hq/dashboard'>
    <TeamWorkspace project={team} team={team} showRecheck={!panel?.submissionFocus} showProjectLink={!panel?.submissionFocus}>
      <TeamReporting panel={panel} teamName={team.name} isLead={team.membership.role==='owner'} nowMs={at} variant='dashboard'/>
    </TeamWorkspace>
  </BuilderShell>;
}
