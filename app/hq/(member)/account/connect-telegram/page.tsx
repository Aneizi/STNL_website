import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BuilderShell } from "@/components/hq/builder-shell";
import { requireMemberActor } from "@/lib/hq/actor";
import { getMemberAuthAvailability } from "@/lib/hq/member-auth-config";
import { TelegramConfirmForm } from "../telegram-confirm-form";

export const metadata: Metadata = { title: "Connect Telegram" };
export const dynamic = "force-dynamic";

// The confirmation step before /link-social. The server action behind the
// form records the intent the auth endpoint then requires.
export default async function ConnectTelegramPage() {
  const actor = await requireMemberActor("/hq/account/connect-telegram");
  if (actor.telegram) redirect("/hq/account");
  const available = getMemberAuthAvailability().telegram;
  return (
    <BuilderShell back="/hq/account">
      <h1>Connect <em>Telegram.</em></h1>
      <p>You will be sent to Telegram to approve the connection. Afterwards you can sign in to this account with Telegram as well as with your email.</p>
      <p>Your account, your teams and your roles stay exactly as they are. A Telegram account can be connected to one HQ account only, and HQ never asks Telegram for your phone number.</p>
      <p>This works within 15 minutes of signing in. If it has been longer, you will be asked to sign in again first.</p>
      {available ? <TelegramConfirmForm action="link" /> : <p>Telegram sign-in is not available yet.</p>}
    </BuilderShell>
  );
}
