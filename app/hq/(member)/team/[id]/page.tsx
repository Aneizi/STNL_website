import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BuilderShell } from '@/components/hq/builder-shell';
import { BuilderTeamControls } from '@/components/hq/builder-onboarding';
import styles from '@/components/hq/builder-shell.module.css';
import { requireMemberActor } from '@/lib/hq/actor';
import { memberTeamView } from '@/lib/hq/member-teams';
export const metadata:Metadata={title:'Your team'};
export const dynamic='force-dynamic';
export default async function TeamPage({params}:{params:Promise<{id:string}>}){
  const {id}=await params;
  const actor=await requireMemberActor(`/hq/team/${encodeURIComponent(id)}`);
  // The central decision, then the member's view and nothing wider. Every denial is this same not-found page.
  const team=await memberTeamView(actor,id);
  if(!team)notFound();
  // A successful import is a usable team straight away: there is no pending
  // or awaiting-approval state to show any more. The only rows that can
  // still be anything but 'verified' are legacy claims from before the
  // owner's 14 September 2026 change, which an admin resolves by deleting
  // them; they are shown honestly rather than hidden.
  const {verification}=team.membership;
  return <BuilderShell back='/hq/dashboard'><h1>{team.name}</h1>
    {verification!=='verified'&&<>
      <span className={styles.status}>Not active</span>
      <p>This is an old import request that never became a team. Ask Superteam NL to remove it, then import your project again.</p>
    </>}
    {team.captain&&<p>Captain: {team.captain.displayName}</p>}
    <BuilderTeamControls team={team}/>
  </BuilderShell>;
}
