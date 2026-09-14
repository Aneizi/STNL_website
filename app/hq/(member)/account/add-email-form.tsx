"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { IconArrowRight } from "symbols-react";
import styles from "@/components/hq/builder-shell.module.css";
import { confirmEmailChange } from "@/lib/hq/actions/telegram";
import { memberAuthClient } from "@/lib/hq/member-auth-client";
import { emailChangeErrorMessage, type EndpointError } from "./email-copy";

const HERE = "/hq/account/add-email";

/**
 * The recovery-email form: the address step confirms the change through the
 * server action (which records the intent the endpoint requires) and asks
 * for a code to be sent to the new address; the verify step turns the code
 * into the account's verified login email. The current address, if any, is
 * never asked for a code.
 */
export function AddEmailForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [step, setStep] = useState<"address" | "verify">("address");
  const [email, setEmail] = useState("");
  /** The normalized address the intent was recorded for; the endpoints get exactly this. */
  const [confirmed, setConfirmed] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [stale, setStale] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === "verify") codeInput.current?.focus();
  }, [step]);

  useEffect(() => {
    if (!resendAt) return;
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((resendAt - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [resendAt]);

  const fail = (failure: EndpointError | string | undefined, fallback: string) => {
    const code = typeof failure === "string" ? failure : failure?.code;
    setStale(code === "SESSION_NOT_FRESH");
    setError(emailChangeErrorMessage(failure, fallback));
  };

  // Every send, including a resend, is its own confirmation: the recorded
  // intent is single use, and the endpoint refuses a request without one.
  const sendCode = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    start(async () => {
      setError("");
      setStatus("");
      setStale(false);
      try {
        const confirmation = await confirmEmailChange(email);
        if (!confirmation.ok) return fail(confirmation.code, "We could not confirm this. Please try again.");
        const result = await memberAuthClient.emailOtp.requestEmailChange({ newEmail: confirmation.newEmail });
        if (result.error) return fail(result.error, "We could not send your code. Please try again shortly.");
        setConfirmed(confirmation.newEmail);
        setEmail(confirmation.newEmail);
        setOtp("");
        setStep("verify");
        setResendAt(Date.now() + 60_000);
        setStatus("Code sent. It expires in 5 minutes.");
      } catch {
        setError("We could not connect. Check your connection and try again.");
      }
    });
  };

  const verifyCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    start(async () => {
      setError("");
      setStale(false);
      try {
        const result = await memberAuthClient.emailOtp.changeEmail({ newEmail: confirmed, otp });
        if (result.error) return fail(result.error, "We could not verify that code. Please try again.");
        router.replace("/hq/account?email=added");
        router.refresh();
      } catch {
        setError("We could not connect. Check your connection and try again.");
      }
    });
  };

  // A session older than the recency window cannot be made recent in place:
  // sign out, then sign in and come straight back here.
  const signInAgain = () => start(async () => {
    const result = await memberAuthClient.signOut();
    if (result.error) return setError("Could not sign out. Please try again.");
    router.replace(`/hq/signin?next=${encodeURIComponent(HERE)}`);
    router.refresh();
  });

  return step === "address" ? (
    <form className={styles.form} onSubmit={sendCode}>
      <label className={styles.field}>
        Email
        <input name="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} required disabled={pending} />
      </label>
      <div className={styles.actions}>
        <button className={styles.button} type="submit" disabled={pending}>
          {pending ? "Sending code…" : "Send code"}
          <IconArrowRight width={18} height={18} fill="currentColor" aria-hidden="true" />
        </button>
        <Link className={styles.textButton} href="/hq/account">Cancel</Link>
      </div>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {stale && <button type="button" className={styles.textButton} disabled={pending} onClick={signInAgain}>Sign in again</button>}
    </form>
  ) : (
    <form className={styles.form} onSubmit={verifyCode}>
      <p>Enter the 6-digit code sent to <strong>{confirmed}</strong>.</p>
      <label className={styles.field}>
        Verification code
        <input ref={codeInput} name="code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} aria-describedby="add-email-status" required disabled={pending} />
      </label>
      <div className={styles.actions}>
        <button className={styles.button} type="submit" disabled={pending || otp.length !== 6}>
          {pending ? "Checking code…" : "Verify email"}
          <IconArrowRight width={18} height={18} fill="currentColor" aria-hidden="true" />
        </button>
        <button type="button" className={styles.textButton} disabled={pending || secondsLeft > 0} onClick={() => sendCode()}>{secondsLeft > 0 ? `Resend in ${secondsLeft}s` : "Resend code"}</button>
        <button type="button" className={styles.textButton} disabled={pending} onClick={() => { setStep("address"); setOtp(""); setError(""); setStatus(""); setStale(false); }}>Use a different address</button>
      </div>
      <p id="add-email-status" role="status" className={styles.success}>{status}</p>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {stale && <button type="button" className={styles.textButton} disabled={pending} onClick={signInAgain}>Sign in again</button>}
    </form>
  );
}
