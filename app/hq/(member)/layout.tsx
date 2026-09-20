import { MemberAccountProvider, type MemberAccountState } from "@/components/hq/builder-account-menu";
import { currentMember } from "@/lib/hq/member-auth";

// NOT the auth boundary and NOT authorization. Layouts don't re-render on
// soft navigation, so every page under this group keeps its own gate
// (requireMember, requireMemberActor) and decides again from the grants at
// request time. This layout only hands the signed-in member's display name
// to the header's avatar menu, from the request-cached member session the
// pages read as well. Read that session directly: currentActor prefers an
// operator when both sessions exist, which would hide a signed-in member's
// account menu. Admin sessions and Captain capabilities do not affect it.
export default async function HqMemberLayout({ children }: { children: React.ReactNode }) {
  const member = await currentMember();
  const value: MemberAccountState = member ? { name: member.name, id: member.id } : null;
  return <MemberAccountProvider value={value}>{children}</MemberAccountProvider>;
}
