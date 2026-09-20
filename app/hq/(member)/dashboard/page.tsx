import type { Metadata } from 'next';
import { CaptainTile, HackathonTile, MenuGrid, PortalTile } from '@/components/hq/builder-menu';
import { BuilderShell } from '@/components/hq/builder-shell';
import { BuilderCaptainWelcome } from '@/components/hq/builder-captain-welcome';
import { requireMemberActor } from '@/lib/hq/actor';
import { builderDatabase } from '@/lib/hq/builder-db';
import { builderStore } from '@/lib/hq/builder-store';
import { listAssignments } from '@/lib/hq/captains';
import { projectNeedsAttention } from '@/lib/hq/dashboard-attention';
import { nowMs } from '@/lib/hq/format';
import { getTelegramBotUrl } from '@/lib/hq/member-auth-config';
import { getBotConsent } from '@/lib/hq/telegram-consent';
import { memberWeekSummaries } from '@/lib/hq/reporting-surface';
import { weekOfLabel } from '@/lib/hq/reporting-view';
import styles from './dashboard.module.css';
export const metadata:Metadata={title:'Home'};
export const dynamic='force-dynamic';
export default async function DashboardPage({searchParams}:{searchParams:Promise<{welcome?:string|string[]}>}){
  const actor=await requireMemberActor('/hq/dashboard');
  const params=await searchParams;
  // One request instant: the week label and the due mark answer to the same moment.
  const at=nowMs();
  const store=builderStore();
  const captain=actor.capabilities.has('captain');
  const [teams,ownProjects,hackathonId,consent]=await Promise.all([store.teams(actor.id),store.ownedProjects(actor.id),store.currentHackathonId(),actor.telegram?getBotConsent(actor.id):null]);
  const projects=[...teams.filter(team=>team.verification==='verified'),...ownProjects];
  // A builder has one team. Should an account hold more, the current
  // edition's comes first, then the newest.
  const team=projects.find(project=>project.hackathonId===hackathonId)??projects[0]??null;
  // The Captain count is this edition's, the same list the Den shows. Only a
  // Captain's Home reads it.
  const [weeks,assignments]=await Promise.all([
    team?memberWeekSummaries([team],undefined,at):[],
    captain&&hackathonId!==null?listAssignments(builderDatabase(),{hackathonId,captainUserId:actor.id}):[],
  ]);
  const week=weeks[0];
  const weekLabel=week?.current?weekOfLabel(week.current.periodSequence,week.totalPeriods):null;
  const firstName=actor.name.trim().split(/\s+/)[0];

  return <BuilderShell bare reminderPrompt={Boolean(getTelegramBotUrl())&&!consent?.messagingEnabled}>
    {captain&&params.welcome==='captain'&&<BuilderCaptainWelcome botUrl={actor.telegram?getTelegramBotUrl():null}/>}
    <div className={styles.home}>
      <h1 className={styles.title}>{firstName?`Where to, ${firstName}?`:'Where to?'}</h1>
      <MenuGrid>
        <HackathonTile team={team?{href:`/hq/team/${team.id}`,weekLabel,updateDue:projectNeedsAttention(week,at)}:null}/>
        <PortalTile/>
        <CaptainTile captain={captain} teamCount={assignments.length}/>
      </MenuGrid>
    </div>
  </BuilderShell>;
}
