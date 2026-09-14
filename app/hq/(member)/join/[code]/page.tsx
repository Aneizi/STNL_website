import type { Metadata } from 'next';
import { BuilderShell } from '@/components/hq/builder-shell';
import { BuilderJoin } from '@/components/hq/builder-onboarding';
import { requireMember } from '@/lib/hq/member-auth';
import { joinLink } from '@/lib/hq/member-routes';

export const metadata:Metadata={title:'Join a team',robots:{index:false,follow:false}};
export const dynamic='force-dynamic';

/**
 * The page a team join link points at. It renders the same screen as /hq/join
 * with the code already filled in, so a teammate who clicks the link their
 * importer sent them does not have to paste anything.
 *
 * Nothing is redeemed by arriving here: the code is looked up and the seat is
 * shown for confirmation, and joining is a separate, explicit action. The
 * page is member gated like every other member page; a signed-out visitor
 * returns to this exact path after signing in.
 */
export default async function JoinWithCodePage({params}:{params:Promise<{code:string}>}){
  const {code}=await params;
  await requireMember(joinLink(encodeURIComponent(code)));
  return <BuilderShell back='/hq/welcome'><h1>Join your <em>team.</em></h1>
    <p>Check this is you, then join.</p>
    <BuilderJoin initialCode={code}/>
  </BuilderShell>;
}
