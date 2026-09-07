import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BuilderShell } from '@/components/hq/builder-shell';
import { BuilderInitialize } from '@/components/hq/builder-onboarding';
import { requireMember } from '@/lib/hq/member-auth';
import { builderStore } from '@/lib/hq/builder-store';
import { nowMs } from '@/lib/hq/format';
export const metadata:Metadata={title:'Initialize your team'};
export const dynamic='force-dynamic';
export default async function InitializePage({searchParams}:{searchParams:Promise<{hackathon?:string}>}){
  const {hackathon}=await searchParams;
  await requireMember(`/hq/initialize${hackathon?`?hackathon=${encodeURIComponent(hackathon)}`:''}`);
  const editions=await builderStore().hackathons();
  const edition=hackathon?editions.find(h=>h.id===Number(hackathon)):editions[0];
  if(!edition)notFound();
  const available=edition.projectsOpen && (!edition.projectsAvailableAt || Date.parse(edition.projectsAvailableAt)<=nowMs());
  return <BuilderShell back='/hq/welcome'><h1>Initialize your <em>team.</em></h1><BuilderInitialize hackathon={edition} available={available}/></BuilderShell>;
}
