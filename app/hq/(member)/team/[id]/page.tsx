import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BuilderShell } from '@/components/hq/builder-shell';
import { TeamWorkspace, type TeamReportingProps, type TeamSnapshotProps } from '@/components/hq/team-workspace';
import { requireMemberActor } from '@/lib/hq/actor';
import { nowMs } from '@/lib/hq/format';
import { memberProjectView, memberTeamView } from '@/lib/hq/member-teams';
import { getTelegramBotUrl } from '@/lib/hq/member-auth-config';
import { teamReportingPanel, type TeamReportingPanel } from '@/lib/hq/reporting-surface';
import { getBotConsent } from '@/lib/hq/telegram-consent';
import type { MemberTeamView } from '@/lib/hq/view-models';
export const metadata:Metadata={title:'Your team'};
export const dynamic='force-dynamic';

/** The reporting half the dossier renders, and nothing it has no block for: the final-period detail stays on the server. */
function reportingProps({projectId,hackathonId,timezone,enrolled,paused,current,history,totalPeriods,entries,nextCursor,teamContact}:TeamReportingPanel):TeamReportingProps{
  return {projectId,hackathonId,timezone,enrolled,paused,current,history,totalPeriods,entries,nextCursor,teamContact};
}

/** The Colosseum half: the snapshot fields the aside prints, and the roster without its row ids. */
function snapshotProps(team:MemberTeamView):TeamSnapshotProps{
  return {
    imageUrl:team.source.imageUrl,
    projectUrl:team.projectUrl,
    stage:team.stage,
    category:team.source.category,
    submissionStatus:team.source.submissionStatus,
    website:team.source.website,
    repoLink:team.source.repoLink,
    leadUsername:team.lead.username,
    roster:team.roster.map(member=>({name:member.name,username:member.username,joined:member.joined})),
  };
}

export default async function TeamPage({params}:{params:Promise<{id:string}>}){
  const {id}=await params;
  // One request instant for the whole page: the week the panel decided, the
  // kicker's due line and the modal's week states all answer to the same moment.
  const at=nowMs();
  const actor=await requireMemberActor(`/hq/team/${encodeURIComponent(id)}`);
  // The central decision, then the member's view and nothing wider. Every denial is this same not-found page.
  const team=await memberTeamView(actor,id);
  // A project an operator created from a Request help submission has no
  // Colosseum snapshot, so there is no BuilderTeam to build a team view from
  // and `memberTeamView` answers null. It is still this account's project,
  // with the same weekly reporting and the same Captain, so it gets the same
  // dossier with the Colosseum half left out rather than a not-found.
  const project=team??await memberProjectView(actor,id);
  if(!project)notFound();
  const [panel,consent]=await Promise.all([
    teamReportingPanel(actor,{projectId:project.id,hackathonId:project.edition.id,atMs:at}),
    // Consent lives on the Telegram identity; without one there is nothing to read and the checkbox renders inert.
    actor.telegram?getBotConsent(actor.id):null,
  ]);
  const verifiedLead=team!==null&&team.membership.role==='owner'&&team.membership.verification==='verified';
  return <BuilderShell bare>
    <TeamWorkspace
      project={{name:project.name,captain:project.captain}}
      team={team?snapshotProps(team):null}
      reporting={reportingProps(panel)}
      canEditTeam={verifiedLead}
      canInvite={team!==null&&team.membership.verification==='verified'}
      nowMs={at}
      hasTelegram={actor.telegram!==null}
      botAllowed={consent?.messagingEnabled??false}
      botUrl={getTelegramBotUrl()}
    />
  </BuilderShell>;
}
