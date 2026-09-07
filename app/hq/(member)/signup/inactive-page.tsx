import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentMember } from "@/lib/hq/member-auth";
import { getMemberAuthAvailability, safeMemberNext } from "@/lib/hq/member-auth-config";
import { AccountForm } from "../account-form";

export const metadata: Metadata = { title: "Create your account", robots: { index: false, follow: false } };

// Preserved for later use. This is not a page.tsx, so it creates no public route.
export default async function SignupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const next = safeMemberNext(params.next);
  if (await currentMember()) redirect(next);
  return <AccountForm mode="signup" next={next} availability={getMemberAuthAvailability()} authError={Boolean(params.error)} />;
}
