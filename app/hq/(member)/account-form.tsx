"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { IconArrowLeft, IconArrowRight } from "symbols-react";
import { memberAuthClient } from "@/lib/hq/member-auth-client";
import { safeMemberNext, type MemberAuthAvailability } from "@/lib/hq/member-auth-config";
import styles from "./account.module.css";

type Props = { mode: "signup" | "signin"; next: string; availability: MemberAuthAvailability; authError?: boolean };

function messageFor(error: { code?: string; status?: number }, verifying = false): string {
  if (error.status === 429 || error.code === "TOO_MANY_REQUESTS") return "Too many attempts. Please wait a minute and try again.";
  if (error.code === "TOO_MANY_ATTEMPTS") return "That code has had too many attempts. Request a new one below.";
  if (error.code === "OTP_EXPIRED" || error.code === "INVALID_OTP") return "That code is incorrect or has expired. Try again or request a new one.";
  if (error.status === 503 || error.code === "AUTH_UNAVAILABLE") return "Sign-in is temporarily unavailable. Please try again shortly.";
  return verifying ? "We could not verify that code. Please try again." : "We could not send your code. Please try again shortly.";
}

export function AccountForm({ mode, next, availability, authError = false }: Props) {
  const [step, setStep] = useState<"details" | "verify">("details");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(authError ? "Sign-in was not completed. Try again or use email." : "");
  const [status, setStatus] = useState("");
  const [resendAt, setResendAt] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const codeInput = useRef<HTMLInputElement>(null);
  const destination = safeMemberNext(next);

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
      setResendAt(Date.now() + 60_000);
      setStatus("Code sent. It expires in 5 minutes.");
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

  async function signInSocial(provider: "google" | "github") {
    if (busy || !availability[provider]) return;
    setBusy(true);
    setError("");
    const errorCallbackURL = `/hq/${mode}?next=${encodeURIComponent(destination)}&error=oauth`;
    try {
      const result = await memberAuthClient.signIn.social({ provider, callbackURL: destination, errorCallbackURL });
      if (result.error) {
        setError("Sign-in could not start. Please try again or use email.");
        setBusy(false);
      }
    } catch {
      setError("We could not connect. Please try again.");
      setBusy(false);
    }
  }

  const unavailableProviders = [!availability.google && "Google", !availability.github && "GitHub"].filter(Boolean).join(" and ");

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
          <h1>{step === "verify" ? <>Check your <em>email.</em></> : mode === "signup" ? <>Create your <em>account.</em></> : <>Welcome <em>back.</em></>}</h1>
          <p className={styles.introduction}>{step === "verify" ? <>Enter the 6-digit code sent to <strong>{email}</strong>.</> : "Your place in Superteam NL HQ."}</p>

          {step === "details" ? (
            <>
              <div className={styles.social}>
                <button type="button" onClick={() => signInSocial("google")} disabled={busy || !availability.google}>Continue with Google</button>
                <button type="button" onClick={() => signInSocial("github")} disabled={busy || !availability.github}>Continue with GitHub</button>
              </div>
              {unavailableProviders && <p className={styles.hint}>{unavailableProviders} sign-in will be available soon.</p>}
              <div className={styles.divider}><span>or use email</span></div>
              <form onSubmit={sendCode} className={styles.form}>
                {mode === "signup" && <label className={styles.field}>
                  Name
                  <input name="name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required disabled={busy} />
                </label>}
                <label className={styles.field}>
                  Email
                  <input name="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} required disabled={busy} />
                </label>
                {!availability.email && <p className={styles.hint}>Email sign-in is not available yet. Please check back shortly.</p>}
                <button className={styles.submit} disabled={busy || !availability.email} type="submit">
                  {busy ? "Sending code…" : "Continue with email"}
                  <IconArrowRight width={19} height={19} fill="currentColor" aria-hidden="true" />
                </button>
                <p className={styles.hint}>We&apos;ll email you a verification code. No password needed.</p>
              </form>
              <p className={styles.switchMode}>{mode === "signup" ? "Already have an account?" : "New here?"} <Link href={`/hq/${mode === "signup" ? "signin" : "signup"}?next=${encodeURIComponent(destination)}`}>{mode === "signup" ? "Sign in" : "Create an account"}</Link></p>
            </>
          ) : (
            <form className={styles.form} onSubmit={verifyCode}>
              <label className={styles.field}>
                Verification code
                <input ref={codeInput} className={styles.code} name="code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} aria-describedby="code-status account-error" required disabled={busy} />
              </label>
              <button className={styles.submit} disabled={busy || otp.length !== 6} type="submit">
                {busy ? "Checking code…" : "Verify and continue"}
                <IconArrowRight width={19} height={19} fill="currentColor" aria-hidden="true" />
              </button>
              <div className={styles.codeActions}>
                <button type="button" disabled={busy || secondsLeft > 0} onClick={() => sendCode()}>{secondsLeft > 0 ? `Resend in ${secondsLeft}s` : "Resend code"}</button>
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
