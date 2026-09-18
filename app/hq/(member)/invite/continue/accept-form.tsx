"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { IconArrowRight } from "symbols-react";
import styles from "@/components/hq/builder-shell.module.css";
import { acceptCaptainInvitationFromContinuation, type AcceptCaptainInvitationActionResult } from "@/lib/hq/actions/invite";
import { CAPTAIN_PATH } from "@/lib/hq/member-routes";
import { inviteOutcomeCopy } from "../copy";

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
export function AcceptInvitationForm({ children }: { children?: React.ReactNode }) {
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
        {result.outcome === "granted" && (
          <div className={styles.actions}>
            <Link className={styles.button} href={CAPTAIN_PATH}>
              Go to Captain
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
      <form action={action} className={styles.actions}>
        <button className={styles.button} type="submit" disabled={pending}>
          {pending ? "Accepting…" : "Accept and become a Captain"}
          <IconArrowRight width={18} height={18} fill="currentColor" aria-hidden="true" />
        </button>
      </form>
    </>
  );
}
