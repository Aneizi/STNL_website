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
  const {verification}=team.membership;
  const status=verification==='verified'?'Verified':verification==='pending'?'Awaiting approval':'Changes needed';
  return <BuilderShell back='/hq/dashboard'><h1>{team.name}</h1><span className={styles.status}>{status}</span>
    {verification==='pending'&&<p>Superteam NL will review your team. You can check your details now. Edits and invites open after approval.</p>}
    {verification==='rejected'&&<p>Superteam NL could not approve this import. Check your Colosseum team and contact us for help.</p>}
    <p><a className={styles.inlineLink} href={team.projectUrl} target='_blank' rel='noopener noreferrer'>View project on Colosseum</a></p>
    <BuilderTeamControls team={team}/>
  </BuilderShell>;
}
