"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { currentMember, getAuth } from "@/lib/hq/member-auth";
import { safeMemberNext } from "@/lib/hq/member-auth-config";
import { syncBuilderAccount } from "@/lib/hq/builder-store";

export type ProfileResult = { error: string } | null;

export async function completeMemberProfile(_previous: ProfileResult, formData: FormData): Promise<ProfileResult> {
  const user = await currentMember();
  const destination = safeMemberNext(formData.get("next"));
  if (!user) redirect(`/hq/signin?next=${encodeURIComponent(destination)}`);
  const rawName = formData.get("name");
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name || name.length > 120) return { error: "Enter your name, using 120 characters or fewer." };
  try {
    await getAuth().api.updateUser({ headers: await headers(), body: { name } });
    await syncBuilderAccount({ ...user, name });
  } catch {
    return { error: "We could not save your name. Please try again." };
  }
  redirect(destination);
}
