import { MemberNavProvider, type MemberNavState } from "@/components/hq/builder-nav";
import { currentActor } from "@/lib/hq/actor";
import { builderStore } from "@/lib/hq/builder-store";
import { getMemberNav } from "@/lib/hq/member-nav";

// NOT the auth boundary and NOT authorization. Layouts don't re-render on
// soft navigation, so every page under this group keeps its own gate
// (requireMember, requireMemberActor) and decides again from the grants at
// request time. This layout only derives what the shell's menu shows, from
// the request-cached actor the pages read as well, and hands it to the
// shell each page renders through the provider. It imports nothing from the
// operator side: no queries, no chrome, no hackathon selection.
export default async function HqMemberLayout({ children }: { children: React.ReactNode }) {
  return <MemberNavProvider value={await memberNavState()}>{children}</MemberNavProvider>;
}

/** The menu for a signed-in member; null for anyone else, so the pre-auth screens and a signed-out skeleton carry no menu. */
async function memberNavState(): Promise<MemberNavState> {
  const actor = await currentActor();
  if (actor?.kind !== "member") return null;
  // actor.telegram is the linked identity row, the same read getLoginMethods() makes for the account page.
  const teamCount = (await builderStore().teams(actor.id)).length;
  return {
    items: getMemberNav({ capabilities: actor.capabilities, hasTelegram: actor.telegram !== null, teamCount }),
    account: { name: actor.name },
  };
}
