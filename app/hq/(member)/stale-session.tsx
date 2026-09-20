"use client";

import { useRouter } from "next/navigation";
import type { TransitionStartFunction } from "react";
import styles from "@/components/hq/builder-shell.module.css";
import { memberAuthClient } from "@/lib/hq/member-auth-client";

type Props = {
  /** Where to come back to after signing in; the member sign-in page keeps it within public HQ. */
  next: string;
  /** The owning form's transition, so its pending state covers the sign-out too. */
  start: TransitionStartFunction;
  disabled: boolean;
  onError: (message: string) => void;
};

/**
 * The way out of a stale session on a confirmation step. A session older
 * than the recency window cannot be made recent in place, and the sign-in
 * page redirects a signed-in member, so: sign out, then sign in and come
 * straight back to `next`.
 */
export function SignInAgain({ next, start, disabled, onError }: Props) {
  const router = useRouter();
  const signInAgain = () => start(async () => {
    const result = await memberAuthClient.signOut();
    if (result.error) return onError("Could not sign out. Please try again.");
    router.replace(`/hq/login?next=${encodeURIComponent(next)}`);
    router.refresh();
  });
  return <button type="button" className={styles.textButton} disabled={disabled} onClick={signInAgain}>Sign in again</button>;
}
