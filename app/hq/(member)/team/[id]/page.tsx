import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BuilderShell } from '@/components/hq/builder-shell';
import { BuilderTeamControls } from '@/components/hq/builder-onboarding';
import { TeamReporting } from '@/components/hq/reporting-member';
import styles from '@/components/hq/builder-shell.module.css';
import { requireMemberActor } from '@/lib/hq/actor';
import { nowMs } from '@/lib/hq/format';
import { memberProjectView, memberTeamView } from '@/lib/hq/member-teams';
import { teamReportingPanel } from '@/lib/hq/reporting-surface';
export const metadata:Metadata={title:'Your team'};
export const dynamic='force-dynamic';
export default async function TeamPage({params}:{params:Promise<{id:string}>}){
  const {id}=await params;
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
    const panel=await teamReportingPanel(actor,{projectId:project.id,hackathonId:project.edition.id});
    return <BuilderShell back='/hq/dashboard'><h1>{project.name}</h1>
      <p>Superteam NL set this project up for you by hand, because it could not be read from Colosseum yet. Once it can be, they will link it here and your teammates, your project link and your Colosseum details will appear. Nothing you write below is affected by that.</p>
      <p>{project.captain
        ?<>Your Captain is {project.captain.displayName}.{project.captain.contact?` Reach them at ${project.captain.contact}.`:' They have not shared a way to reach them yet.'}</>
        :'No Captain assigned yet. You can still add your updates.'}</p>
      <TeamReporting panel={panel} teamName={project.name} isLead={project.membership.role==='owner'} nowMs={nowMs()}/>
    </BuilderShell>;
  }
  // A successful import is a usable team straight away: there is no pending
  // or awaiting-approval state to show any more. The only rows that can
  // still be anything but 'verified' are legacy claims from before the
  // owner's 14 September 2026 change, which an admin resolves by deleting
  // them; they are shown honestly rather than hidden.
  const {verification}=team.membership;
  // Weekly reporting is read only for a team this account really belongs to:
  // an unverified claim is not a team yet, so it has no week of its own.
  const panel=verification==='verified'?await teamReportingPanel(actor,{projectId:team.id,hackathonId:team.edition.id}):null;
  return <BuilderShell back='/hq/dashboard'><h1>{team.name}</h1>
    {verification!=='verified'&&<>
      <span className={styles.status}>Not active</span>
      <p>This is an old import request that never became a team. Ask Superteam NL to remove it, then import your project again.</p>
    </>}
    {/* A team has a Captain whether or not weekly updates have started for
        it, so the Captain line sits here rather than inside the week. The
        contact is only ever what that Captain typed in themselves. */}
    {verification==='verified'&&<p>{team.captain
      ?<>Your Captain is {team.captain.displayName}.{team.captain.contact?` Reach them at ${team.captain.contact}.`:' They have not shared a way to reach them yet.'}</>
      :'No Captain assigned yet. You can still add your updates.'}</p>}
    {panel&&<TeamReporting panel={panel} teamName={team.name} isLead={team.membership.role==='owner'} nowMs={nowMs()}/>}
    <BuilderTeamControls team={team}/>
  </BuilderShell>;
}
