"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { currentMember, getAuth, redirectToMemberSignIn } from "@/lib/hq/member-auth";
import { safeMemberNext } from "@/lib/hq/member-auth-config";
import { syncBuilderAccount } from "@/lib/hq/builder-store";
import { setBotConsent, TelegramNotConnectedError } from "@/lib/hq/telegram-consent";

export type ProfileResult = { error: string } | null;

export async function completeMemberProfile(_previous: ProfileResult, formData: FormData): Promise<ProfileResult> {
  const user = await currentMember();
  const destination = safeMemberNext(formData.get("next"));
  if (!user) return redirectToMemberSignIn(destination);
  const rawName = formData.get("name");
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) return { error: "Enter your name." };
  if (name.length > 120) return { error: "Enter your name, using 120 characters or fewer." };
  // The only thing the form says about the bot: whether the box was ticked.
  // An unticked box on a fresh account records no decision.
  const botAllowed = formData.get("botAllowed") === "on";
  try {
    await getAuth().api.updateUser({ headers: await headers(), body: { name } });
    // The consent row references the builder profile, so the sync comes first.
    await syncBuilderAccount({ id: user.id, email: user.email, name });
    await setBotConsent({ kind: "member", id: user.id }, botAllowed);
  } catch (error) {
    // An account without Telegram has nobody to message: the box was never
    // offered and there is nothing to store. Anything else is worth a retry,
    // which is idempotent for the parts that already landed.
    if (!(error instanceof TelegramNotConnectedError)) return { error: "We could not save your name. Please try again." };
  }
  redirect(destination);
}
