import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentMember } from "@/lib/hq/member-auth";
import { getMemberAuthAvailability, safeMemberNext } from "@/lib/hq/member-auth-config";
import { AccountForm } from "../account-form";

export const metadata: Metadata = { title: "Enter HQ", robots: { index: false, follow: false } };

export default async function MemberLoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const next = safeMemberNext(params.next);
  if (await currentMember()) redirect(next);
  return <AccountForm next={next} availability={getMemberAuthAvailability()} error={params.error} />;
}
