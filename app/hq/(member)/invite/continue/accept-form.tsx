"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { IconArrowRight } from "symbols-react";
import styles from "@/components/hq/builder-shell.module.css";
import { acceptCaptainInvitationFromContinuation, type AcceptCaptainInvitationActionResult } from "@/lib/hq/actions/invite";
import { inviteOutcomeCopy } from "../copy";
import formStyles from "./accept-form.module.css";

const INITIAL: AcceptCaptainInvitationActionResult | null = null;

/**
 * The explicit acceptance step: a plain Server Action form, no client SDK
 * call involved (unlike the Telegram confirmation forms next door). Submitting
 * is the only way this account's redemption ever runs: a page load never
 * calls the action, and the action itself re-derives every outcome from
 * acceptCaptainInvitation rather than trusting anything rendered here.
 *
 * `children` is the page's explanation of what accepting does. It belongs to
 * the open invitation, so it renders ahead of the button and goes with it
 * the moment any result takes their place; every result explains itself.
 */
export function AcceptInvitationForm({ children, hasTelegram, botEnabled }: {
  children?: React.ReactNode;
  hasTelegram: boolean;
  botEnabled: boolean;
}) {
  const router = useRouter();
  const [result, action, pending] = useActionState(acceptCaptainInvitationFromContinuation, INITIAL);

  useEffect(() => {
    // Refreshes the server-rendered tree so every capability-driven surface
    // (the Captains' Den tile on Home) picks the grant up without a reload.
    if (result?.outcome === "granted") router.refresh();
  }, [result, router]);

  if (result) {
    const copy = inviteOutcomeCopy(result.outcome);
    return (
      <div role={copy.tone === "good" ? "status" : "alert"}>
        <h2>
          {copy.heading} <em>{copy.emphasis}</em>
        </h2>
        <p className={copy.tone === "good" ? styles.success : styles.error}>{copy.body}</p>
        {result.botError && (
          <p role="alert" className={styles.error}>
            {result.botError === "not-connected"
              ? "Telegram is no longer connected. Connect it in Account to enable bot reminders."
              : "We could not save your bot reminder preference. Try again in Account."}{" "}
            <Link className={styles.inlineLink} href="/hq/account">Open Account</Link>
          </p>
        )}
        {copy.tone === "good" && (
          <div className={styles.actions}>
            <Link className={styles.button} href="/hq/dashboard">
              Go to menu
              <IconArrowRight width={18} height={18} fill="currentColor" aria-hidden="true" />
            </Link>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {children}
      <form action={action}>
        <div className={formStyles.reminders}>
          <input type="hidden" name="botMessagingPreference" value="included" disabled={!hasTelegram || pending} />
          <label className={formStyles.switchRow}>
            <span>Bot reminders on Telegram</span>
            <input
              type="checkbox"
              role="switch"
              name="botMessaging"
              className={formStyles.switchInput}
              defaultChecked={hasTelegram && botEnabled}
              disabled={!hasTelegram || pending}
              aria-describedby="bot-reminders-description"
            />
            <span aria-hidden="true" className={formStyles.switchTrack}><span className={formStyles.switchKnob} /></span>
          </label>
          <p id="bot-reminders-description" className={formStyles.description}>
            {hasTelegram ? (
              "Recommended for captains. Get reminders to follow up with your teams. Your choice is saved when you accept, and you can change it in Account."
            ) : (
              <>Recommended for captains. <Link className={styles.inlineLink} href="/hq/account">Connect Telegram in Account</Link>, then return here to enable reminders. You can also accept now and set this up later.</>
            )}
          </p>
        </div>
        <div className={styles.actions}>
          <button className={styles.button} type="submit" disabled={pending}>
            {pending ? "Accepting…" : "Accept and become a Captain"}
            <IconArrowRight width={18} height={18} fill="currentColor" aria-hidden="true" />
          </button>
        </div>
      </form>
    </>
  );
}
