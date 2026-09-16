"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { IconArrowLeft, IconArrowRight, IconPaperplaneFill } from "symbols-react";
import { memberAuthClient } from "@/lib/hq/member-auth-client";
import { safeMemberNext, type MemberAuthAvailability } from "@/lib/hq/member-auth-config";
import styles from "./account.module.css";
import { CODE_SENT_COPY, OtpCodeField, ResendCodeButton } from "./otp-code-field";
import { telegramErrorMessage, telegramFailure } from "./telegram-copy";
import { useResendCooldown } from "./use-resend-cooldown";

type Props = {
  mode: "signup" | "signin";
  next: string;
  availability: MemberAuthAvailability;
  /** The `error` value(s) the Telegram callback or a sign-in redirect put in the URL; shown once, as copy. */
  error?: string | string[];
};

/**
 * Honest unavailable copy per method and per mode. When neither method is
 * configured there is one line, not two; when one is, its line says which
 * and points at the other.
 */
function unavailableCopy(mode: Props["mode"], availability: MemberAuthAvailability): { all: string | null; telegram: string | null; email: string | null } {
  const action = mode === "signup" ? "Sign-up" : "Sign-in";
  const verb = mode === "signup" ? "sign-up" : "sign-in";
  if (!availability.telegram && !availability.email) return { all: `${action} is not available yet. Please check back shortly.`, telegram: null, email: null };
  return {
    all: null,
    telegram: availability.telegram ? null : `Telegram ${verb} is not available yet. Use email below.`,
    email: availability.email ? null : `Email ${verb} is not available yet. Use Telegram above.`,
  };
}

function messageFor(error: { code?: string; status?: number }, verifying = false): string {
  if (error.status === 429 || error.code === "TOO_MANY_REQUESTS") return "Too many attempts. Please wait a minute and try again.";
  if (error.code === "TOO_MANY_ATTEMPTS") return "That code has had too many attempts. Request a new one below.";
  if (error.code === "OTP_EXPIRED" || error.code === "INVALID_OTP") return "That code is incorrect or has expired. Try again or request a new one.";
  if (error.status === 503 || error.code === "AUTH_UNAVAILABLE") return "Sign-in is temporarily unavailable. Please try again shortly.";
  return verifying ? "We could not verify that code. Please try again." : "We could not send your code. Please try again shortly.";
}

export function AccountForm({ mode, next, availability, error: initialError }: Props) {
  const [step, setStep] = useState<"details" | "verify">("details");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(telegramErrorMessage(initialError) ?? "");
  const [status, setStatus] = useState("");
  const { secondsLeft, startCooldown } = useResendCooldown();
  const codeInput = useRef<HTMLInputElement>(null);
  const destination = safeMemberNext(next);
  const unavailable = unavailableCopy(mode, availability);

  useEffect(() => {
    if (step === "verify") codeInput.current?.focus();
  }, [step]);

  async function signInWithTelegram() {
    if (busy || !availability.telegram) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      // The redirect flow only: the server mints state, PKCE and nonce and
      // sends the browser to Telegram. On success the client follows the
      // returned URL, so `busy` stays on. A first-time account lands on the
      // name step, which needs no email.
      const result = await memberAuthClient.signIn.social({
        provider: "telegram",
        callbackURL: destination,
        errorCallbackURL: `/hq/login?error=telegram&next=${encodeURIComponent(destination)}`,
        newUserCallbackURL: `/hq/profile?next=${encodeURIComponent(destination)}`,
      });
      if (result.error) {
        setError(telegramErrorMessage(result.error.code) ?? telegramFailure("signin"));
        setBusy(false);
      }
    } catch {
      setError("We could not connect. Check your connection and try again.");
      setBusy(false);
    }
  }

  async function sendCode(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (busy || !availability.email) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await memberAuthClient.emailOtp.sendVerificationOtp({ email: email.trim(), type: "sign-in" });
      if (result.error) {
        setError(messageFor(result.error));
        return;
      }
      setEmail(email.trim());
      setOtp("");
      setStep("verify");
      startCooldown();
      setStatus(CODE_SENT_COPY);
      codeInput.current?.focus();
    } catch {
      setError("We could not connect. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await memberAuthClient.signIn.emailOtp({ email, otp, ...(name.trim() ? { name: name.trim() } : {}) });
      if (result.error) {
        setError(messageFor(result.error, true));
        return;
      }
      // A full navigation makes the verified cookie available to the server.
      window.location.assign(destination);
    } catch {
      setError("We could not connect. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="Superteam NL home">
          <Image src="/landing/st-orange.png" alt="" width={2154} height={2116} sizes="28px" />
          <span>superteam NL</span>
        </Link>
        <Link href="/colosseum/start" className={styles.back}>
          <IconArrowLeft width={16} height={16} fill="currentColor" aria-hidden="true" />
          Back
        </Link>
      </header>
      <main className={styles.main}>
        <div className={styles.content}>
          <h1>{step === "verify" ? "Check your email" : "Enter HQ"}</h1>
          {step === "verify" && <p className={styles.introduction}>Enter the 6-digit code sent to <strong>{email}</strong>.</p>}

          {step === "details" ? (
            <>
              <div className={styles.providers}>
                <button type="button" className={styles.provider} disabled={busy || !availability.telegram} onClick={signInWithTelegram}>
                  <IconPaperplaneFill width={18} height={18} fill="currentColor" aria-hidden="true" />
                  Continue with Telegram
                </button>
                {unavailable.telegram && <p className={styles.hint}>{unavailable.telegram}</p>}
              </div>
              <div className={styles.divider} aria-hidden="true"><span>or use email</span></div>
              <form onSubmit={sendCode} className={styles.form}>
                {mode === "signup" && <label className={styles.field}>
                  Name
                  <input name="name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required disabled={busy} />
                </label>}
                <div className={styles.field}>
                  <input aria-label="Email" placeholder="example@gmail.com" name="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} required disabled={busy} />
                </div>
                {unavailable.email && <p className={styles.hint}>{unavailable.email}</p>}
                <button className={styles.submit} disabled={busy || !availability.email} type="submit">
                  {busy ? "Sending code…" : "Continue with email"}
                  <IconArrowRight width={19} height={19} fill="currentColor" aria-hidden="true" />
                </button>
                <p className={styles.hint}>We&apos;ll email you a verification code. No password needed.</p>
              </form>
              {unavailable.all && <p className={styles.hint}>{unavailable.all}</p>}
              {mode === "signup" && <p className={styles.switchMode}>Already have an account? <Link href={`/hq/login?next=${encodeURIComponent(destination)}`}>Sign in</Link></p>}
            </>
          ) : (
            <form className={styles.form} onSubmit={verifyCode}>
              <OtpCodeField inputRef={codeInput} value={otp} onChange={setOtp} disabled={busy} describedBy="code-status account-error" labelClassName={styles.field} inputClassName={styles.code} />
              <button className={styles.submit} disabled={busy || otp.length !== 6} type="submit">
                {busy ? "Checking code…" : "Verify and continue"}
                <IconArrowRight width={19} height={19} fill="currentColor" aria-hidden="true" />
              </button>
              <div className={styles.codeActions}>
                <ResendCodeButton secondsLeft={secondsLeft} disabled={busy} onClick={() => sendCode()} />
                <button type="button" disabled={busy} onClick={() => { setStep("details"); setOtp(""); setError(""); setStatus(""); }}>Change email</button>
              </div>
            </form>
          )}
          <p id="code-status" role="status" className={styles.hint}>{status}</p>
          <p id="account-error" role="alert" className={styles.error}>{error}</p>
        </div>
      </main>
    </div>
  );
}
