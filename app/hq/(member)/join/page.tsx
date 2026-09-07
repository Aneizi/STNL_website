import type { Metadata } from 'next';
import { BuilderShell } from '@/components/hq/builder-shell';
import { BuilderJoin } from '@/components/hq/builder-onboarding';
import { requireMember } from '@/lib/hq/member-auth';
export const metadata:Metadata={title:'Join a team'};
export const dynamic='force-dynamic';
export default async function JoinPage(){
  await requireMember('/hq/join');
  return <BuilderShell back='/hq/welcome'><h1>Join your <em>team.</em></h1><p>Enter the code your team shared with you.</p><BuilderJoin/></BuilderShell>;
}
