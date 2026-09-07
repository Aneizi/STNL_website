"use client";

import { useActionState } from "react";
import { IconArrowRight } from "symbols-react";
import { completeMemberProfile } from "./actions";
import styles from "../account.module.css";

export function ProfileForm({ next }: { next: string }) {
  const [result, action, pending] = useActionState(completeMemberProfile, null);
  return (
    <form action={action} className={styles.form}>
      <input type="hidden" name="next" value={next} />
      <label className={styles.field}>
        Name
        <input name="name" autoComplete="name" maxLength={120} required disabled={pending} aria-describedby="profile-error" />
      </label>
      <button className={styles.submit} type="submit" disabled={pending}>
        {pending ? "Saving…" : "Continue"}
        <IconArrowRight width={19} height={19} fill="currentColor" aria-hidden="true" />
      </button>
      <p className={styles.error} id="profile-error" role="alert">{result?.error}</p>
    </form>
  );
}
