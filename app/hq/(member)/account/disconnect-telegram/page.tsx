import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BuilderShell } from "@/components/hq/builder-shell";
import styles from "@/components/hq/builder-shell.module.css";
import { requireMemberActor } from "@/lib/hq/actor";
import { TelegramConfirmForm } from "../telegram-confirm-form";

export const metadata: Metadata = { title: "Disconnect Telegram" };
export const dynamic = "force-dynamic";

// The confirmation step before /unlink-account. The server action behind the
// form re-checks that a verified email remains and records the intent the
// auth endpoint then requires.
export default async function DisconnectTelegramPage() {
  const actor = await requireMemberActor("/hq/account/disconnect-telegram");
  if (!actor.telegram) redirect("/hq/account");
  // actor.email is the verified login email; null means Telegram is the only way in.
  const lastLoginMethod = actor.email === null;
  return (
    <BuilderShell back="/hq/account">
      <h1>Disconnect <em>Telegram.</em></h1>
      {lastLoginMethod ? (
        <>
          <p>Telegram is the only way to sign in to this account, so it cannot be disconnected. Add a verified email first.</p>
          <Link className={styles.secondary} href="/hq/account">Back to your account</Link>
        </>
      ) : (
        <>
          <p>You will no longer be able to sign in with Telegram. Signing in with your email, {actor.email}, keeps working, and your account, your teams and your roles stay as they are.</p>
          <p>You can connect Telegram again at any time.</p>
          <TelegramConfirmForm action="unlink" />
        </>
      )}
    </BuilderShell>
  );
}
