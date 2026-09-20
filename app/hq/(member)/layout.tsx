import { MemberAccountProvider, type MemberAccountState } from "@/components/hq/builder-account-menu";
import { currentMember } from "@/lib/hq/member-auth";

// Layouts persist across soft navigation, so each page keeps its own auth gate.
// This supplies only the member's avatar identity; an operator session must not
// replace it when both sessions exist.
export default async function HqMemberLayout({ children }: { children: React.ReactNode }) {
  const member = await currentMember();
  const value: MemberAccountState = member ? { name: member.name, id: member.id } : null;
  return <MemberAccountProvider value={value}>{children}</MemberAccountProvider>;
}
