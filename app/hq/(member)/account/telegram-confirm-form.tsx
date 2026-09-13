"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { IconArrowRight } from "symbols-react";
import styles from "@/components/hq/builder-shell.module.css";
import { confirmLinkTelegram, confirmUnlinkTelegram } from "@/lib/hq/actions/telegram";
import { memberAuthClient } from "@/lib/hq/member-auth-client";
import { telegramErrorMessage } from "../telegram-copy";

type Props = { action: "link" | "unlink" };

/**
 * The confirmation step's form. Submitting runs the server action, which
 * records the confirmed intent; only then does the client call the auth
 * endpoint, and the server refuses that call without the recorded intent.
 */
export function TelegramConfirmForm({ action }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const here = action === "link" ? "/hq/account/connect-telegram" : "/hq/account/disconnect-telegram";

  const fail = (code: string | undefined, fallback: string) => {
    setStale(code === "SESSION_NOT_FRESH");
    setError(telegramErrorMessage(code, "connect") ?? fallback);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    start(async () => {
      setError("");
      setStale(false);
      if (action === "link") {
        const confirmation = await confirmLinkTelegram();
        if (!confirmation.ok) return fail(confirmation.code, "We could not confirm this. Please try again.");
        // The browser follows the returned Telegram URL; the callback lands
        // back on the account page with the outcome.
        const result = await memberAuthClient.linkSocial({ provider: "telegram", callbackURL: "/hq/account?connected=telegram", errorCallbackURL: "/hq/account?error=telegram" });
        if (result.error) return fail(result.error.code, "We could not start the Telegram connection. Please try again.");
        setLeaving(true);
        return;
      }
      const confirmation = await confirmUnlinkTelegram();
      if (!confirmation.ok) return fail(confirmation.code, "We could not confirm this. Please try again.");
      const result = await memberAuthClient.unlinkAccount({ accountId: confirmation.accountId });
      if (result.error) return fail(result.error.code, "We could not disconnect Telegram. Please try again.");
      router.replace("/hq/account?disconnected=telegram");
      router.refresh();
    });
  };

  // A session older than the recency window cannot be made recent in place:
  // sign out, then sign in and come straight back here.
  const signInAgain = () => start(async () => {
    const result = await memberAuthClient.signOut();
    if (result.error) return setError("Could not sign out. Please try again.");
    router.replace(`/hq/signin?next=${encodeURIComponent(here)}`);
    router.refresh();
  });

  return (
    <form onSubmit={submit}>
      <div className={styles.actions}>
        <button className={action === "link" ? styles.button : styles.secondary} type="submit" disabled={pending || leaving}>
          {action === "link" ? (leaving ? "Opening Telegram…" : "Continue to Telegram") : "Disconnect Telegram"}
          <IconArrowRight width={18} height={18} fill="currentColor" aria-hidden="true" />
        </button>
        <Link className={styles.textButton} href="/hq/account">Cancel</Link>
      </div>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {stale && <button type="button" className={styles.textButton} disabled={pending} onClick={signInAgain}>Sign in again</button>}
    </form>
  );
}
