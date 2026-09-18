import type { Metadata } from 'next';
import { BuilderShell } from '@/components/hq/builder-shell';
import { BuilderWelcome } from '@/components/hq/builder-onboarding';
import { requireMember } from '@/lib/hq/member-auth';
import { builderStore } from '@/lib/hq/builder-store';
export const metadata:Metadata={title:'Find your team'};
export const dynamic='force-dynamic';
export default async function WelcomePage(){
  await requireMember('/hq/welcome');
  // Import goes to the open edition, live first; without one the Initialize page answers for itself.
  const [edition]=await builderStore().hackathons();
  return <BuilderShell back='/colosseum/start'><h1>Find your <em>team.</em></h1><p>Choose how you’d like to take part.</p><BuilderWelcome hackathonId={edition?.id??null}/></BuilderShell>;
}
