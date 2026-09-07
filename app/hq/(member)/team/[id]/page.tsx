import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BuilderShell } from '@/components/hq/builder-shell';
import { BuilderTeamControls } from '@/components/hq/builder-onboarding';
import styles from '@/components/hq/builder-shell.module.css';
import { requireMember } from '@/lib/hq/member-auth';
import { builderStore } from '@/lib/hq/builder-store';
export const metadata:Metadata={title:'Your team'};
export const dynamic='force-dynamic';
export default async function TeamPage({params}:{params:Promise<{id:string}>}){
  const {id}=await params;
  const user=await requireMember(`/hq/team/${encodeURIComponent(id)}`);
  const team=(await builderStore().teams(user.id)).find(t=>t.id===id);
  if(!team)notFound();
  const status=team.verification==='verified'?'Verified':team.verification==='pending'?'Awaiting approval':'Changes needed';
  return <BuilderShell><h1>{team.name}</h1><span className={styles.status}>{status}</span>
    {team.verification==='pending'&&<p>Superteam NL will review your team. You can check your details now. Invites open after approval.</p>}
    {team.verification==='rejected'&&<p>Superteam NL could not approve this import. Check your Colosseum team and contact us for help.</p>}
    <p><a className={styles.inlineLink} href={team.projectUrl} target='_blank' rel='noopener noreferrer'>View project on Colosseum</a></p>
    <BuilderTeamControls team={team} isOwner={team.ownerId===user.id}/>
  </BuilderShell>;
}
