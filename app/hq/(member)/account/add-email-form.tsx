"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { IconArrowRight } from "symbols-react";
import styles from "@/components/hq/builder-shell.module.css";
import { confirmEmailChange } from "@/lib/hq/actions/telegram";
import { memberAuthClient } from "@/lib/hq/member-auth-client";
import { CODE_SENT_COPY, OtpCodeField, ResendCodeButton } from "../otp-code-field";
import { SignInAgain } from "../stale-session";
import { useResendCooldown } from "../use-resend-cooldown";
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
  const { secondsLeft, startCooldown } = useResendCooldown();
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === "verify") codeInput.current?.focus();
  }, [step]);

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
        startCooldown();
        setStatus(CODE_SENT_COPY);
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
      {stale && <SignInAgain next={HERE} start={start} disabled={pending} onError={setError} />}
    </form>
  ) : (
    <form className={styles.form} onSubmit={verifyCode}>
      <p>Enter the 6-digit code sent to <strong>{confirmed}</strong>.</p>
      <OtpCodeField inputRef={codeInput} value={otp} onChange={setOtp} disabled={pending} describedBy="add-email-status" labelClassName={styles.field} />
      <div className={styles.actions}>
        <button className={styles.button} type="submit" disabled={pending || otp.length !== 6}>
          {pending ? "Checking code…" : "Verify email"}
          <IconArrowRight width={18} height={18} fill="currentColor" aria-hidden="true" />
        </button>
        <ResendCodeButton className={styles.textButton} secondsLeft={secondsLeft} disabled={pending} onClick={() => sendCode()} />
        <button type="button" className={styles.textButton} disabled={pending} onClick={() => { setStep("address"); setOtp(""); setError(""); setStatus(""); setStale(false); }}>Use a different address</button>
      </div>
      <p id="add-email-status" role="status" className={styles.success}>{status}</p>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {stale && <SignInAgain next={HERE} start={start} disabled={pending} onError={setError} />}
    </form>
  );
}
