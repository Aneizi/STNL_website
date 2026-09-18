import { MemberAccountProvider, type MemberAccountState } from "@/components/hq/builder-account-menu";
import { currentActor } from "@/lib/hq/actor";

// NOT the auth boundary and NOT authorization. Layouts don't re-render on
// soft navigation, so every page under this group keeps its own gate
// (requireMember, requireMemberActor) and decides again from the grants at
// request time. This layout only hands the signed-in member's display name
// to the header's avatar menu, from the request-cached actor the pages read
// as well, through the provider the shell each page renders reads back. It
// makes no read of its own and imports nothing from the operator side: no
// queries, no chrome, no hackathon selection.
export default async function HqMemberLayout({ children }: { children: React.ReactNode }) {
  const actor = await currentActor();
  const value: MemberAccountState = actor?.kind === "member" ? { name: actor.name } : null;
  return <MemberAccountProvider value={value}>{children}</MemberAccountProvider>;
}
