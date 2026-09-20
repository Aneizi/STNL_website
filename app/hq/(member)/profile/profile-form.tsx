"use client";

import { useActionState, useState, type FormEvent } from "react";
import { IconArrowRight } from "symbols-react";
import { TelegramBotStart } from "@/components/hq/telegram-bot-start";
import { completeMemberProfile } from "./actions";
import styles from "../account.module.css";

export function ProfileForm({ next, hasTelegram, botUrl }: { next: string; hasTelegram: boolean; botUrl: string | null }) {
  const [result, action, pending] = useActionState(completeMemberProfile, null);
  const [name, setName] = useState("");
  const [botAllowed, setBotAllowed] = useState(true);
  const [localError, setLocalError] = useState("");
  // The server's answer belongs to the previous attempt while a new one is in flight.
  const error = localError || (pending ? "" : (result?.error ?? ""));

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    if (name.trim()) {
      setLocalError("");
      return;
    }
    // `required` only stops a truly empty field; whitespace gets here.
    event.preventDefault();
    setLocalError("Enter your name.");
  }

  return (
    <form action={action} onSubmit={onSubmit} className={styles.form}>
      <input type="hidden" name="next" value={next} />
      <label className={styles.field}>
        Name
        <input name="name" autoComplete="name" maxLength={120} required value={name} onChange={(event) => setName(event.target.value)} disabled={pending} aria-describedby={error ? "profile-error" : undefined} />
      </label>
      {hasTelegram && (
        <label className={styles.check}>
          <input type="checkbox" name="botAllowed" checked={botAllowed} onChange={(event) => setBotAllowed(event.target.checked)} disabled={pending} />
          Allow the Superteam NL bot to reach you on Telegram for reminders
        </label>
      )}
      {hasTelegram && <TelegramBotStart botUrl={botUrl} />}
      <button className={styles.submit} type="submit" disabled={pending}>
        {pending ? "Saving…" : "Continue"}
        <IconArrowRight width={19} height={19} fill="currentColor" aria-hidden="true" />
      </button>
      {error && <p className={styles.error} id="profile-error" role="alert">{error}</p>}
    </form>
  );
}
