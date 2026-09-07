import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentMember } from "@/lib/hq/member-auth";
import { getMemberAuthAvailability, safeMemberNext } from "@/lib/hq/member-auth-config";
import { AccountForm } from "../account-form";

export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: false } };

export default async function SigninPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const next = safeMemberNext(params.next);
  if (await currentMember()) redirect(next);
  return <AccountForm mode="signin" next={next} availability={getMemberAuthAvailability()} authError={Boolean(params.error)} />;
}
