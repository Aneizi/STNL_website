"use client";

import { TelegramBotStart } from "@/components/hq/telegram-bot-start";

import { useModalFocus } from '@/components/hq/use-modal-focus';

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type FormEvent, type MouseEvent, type TransitionStartFunction } from "react";
import { IconArrowLeft, IconArrowRight } from "symbols-react";
import { confirmEmailChange, confirmLinkTelegram, confirmUnlinkTelegram, setBotMessaging } from "@/lib/hq/actions/telegram";
import { memberAuthClient } from "@/lib/hq/member-auth-client";
import { ResendCodeButton } from "../otp-code-field";
import { SignInAgain } from "../stale-session";
import { telegramErrorMessage } from "../telegram-copy";
import { useResendCooldown } from "../use-resend-cooldown";
import { emailChangeErrorMessage, type EndpointError } from "./email-copy";
import styles from "./account-passport.module.css";

const HERE = "/hq/account";
const CONNECTION_FAILED = "We could not connect. Check your connection and try again.";

/** The role hierarchy's label: Captain (granted) over Member (granted) over Builder (has a team or a project) over User. */
export type AccountRole = "Captain" | "Member" | "Builder" | "User";
type Modal = "email" | "disconnect" | "connect";
type Step = "email" | "code";

export type AccountPassportProps = {
  name: string;
  role: AccountRole;
  /** The stored login address, verified or not; null for a Telegram-only account. */
  email: string | null;
  /** The verified rule, the one the unlink guard uses: the account can sign in with `email`. */
  hasEmail: boolean;
  /** The connected Telegram, with its username when Telegram gave one. Never the Telegram id. */
  telegram: { username: string | null } | null;
  teamName: string | null;
  /** The stored bot-messaging decision; never inferred from the connection. */
  bot: boolean;
  botUrl: string | null;
  /** Whether each method is configured; an unavailable one has no row. */
  emailAvailable: boolean;
  telegramAvailable: boolean;
  /** The outcome the Telegram OAuth round trip left in the URL, if any. */
  initialNotice: string | null;
  initialError: string | null;
};

const arrow = <IconArrowRight width={18} height={18} fill="currentColor" aria-hidden="true" />;

/**
 * The account page: the action rows, the ink passport card and the three
 * modals (email, disconnect, connect). Every identity change is the design's
 * two steps in the modal, backed by the same confirmation-then-endpoint
 * pairs as before: the server action records the intent, then the auth
 * client calls the endpoint that consumes it. The accountId for unlinking
 * comes from confirmUnlinkTelegram() alone. Outcomes are announced in the
 * notice line from client state, and the server card is refreshed so the
 * rows and the facts follow the stored account.
 */
export function AccountPassport(props: AccountPassportProps) {
  const { name, role, email, hasEmail, telegram, teamName, emailAvailable, telegramAvailable } = props;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [switchPending, startSwitch] = useTransition();
  const [modal, setModal] = useState<Modal | null>(null);
  const [step, setStep] = useState<Step>("email");
  const [draft, setDraft] = useState("");
  /** The normalized address the intent was recorded for and the code went to; the endpoints get exactly this. */
  const [confirmed, setConfirmed] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [notice, setNotice] = useState(props.initialNotice);
  const [pageError, setPageError] = useState(props.initialError);
  const [bot, setBot] = useState(props.bot);
  const [switchError, setSwitchError] = useState("");
  const { secondsLeft, startCooldown } = useResendCooldown(30_000);
  /** The row that opened the modal, so focus returns to it when the modal closes. */
  const opener = useRef<HTMLElement | null>(null);
  const hasTelegram = telegram !== null;

  useEffect(() => {
    if (!modal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setModal(null);
      opener.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [modal]);

  const close = () => {
    setModal(null);
    opener.current?.focus();
  };

  // Called from the row's click only: the ref is written in the event, never during render.
  const openModal = (kind: Modal, event: MouseEvent<HTMLButtonElement>) => {
    opener.current = event.currentTarget;
    setModal(kind);
    setStep("email");
    setDraft("");
    setConfirmed("");
    setOtp("");
    setError("");
    setStale(false);
    setLeaving(false);
    setNotice(null);
    setPageError(null);
  };

  const failEmail = (failure: EndpointError | string | undefined, fallback: string) => {
    const code = typeof failure === "string" ? failure : failure?.code;
    setStale(code === "SESSION_NOT_FRESH");
    setError(emailChangeErrorMessage(failure, fallback));
  };

  const failTelegram = (code: string | undefined, fallback: string) => {
    setStale(code === "SESSION_NOT_FRESH");
    setError(telegramErrorMessage(code, "connect") ?? fallback);
  };

  // Every send, including a resend, is its own confirmation: the recorded
  // intent is single use, and the endpoint refuses a request without one.
  const sendCode = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!draft.includes("@")) {
      setError("Enter a valid email.");
      return;
    }
    start(async () => {
      setError("");
      setStale(false);
      try {
        const confirmation = await confirmEmailChange(draft);
        if (!confirmation.ok) return failEmail(confirmation.code, "We could not confirm this. Please try again.");
        const result = await memberAuthClient.emailOtp.requestEmailChange({ newEmail: confirmation.newEmail });
        if (result.error) return failEmail(result.error, "We could not send your code. Please try again shortly.");
        setConfirmed(confirmation.newEmail);
        setDraft(confirmation.newEmail);
        setOtp("");
        setStep("code");
        startCooldown();
      } catch {
        setError(CONNECTION_FAILED);
      }
    });
  };

  const verify = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    start(async () => {
      setError("");
      setStale(false);
      try {
        const result = await memberAuthClient.emailOtp.changeEmail({ newEmail: confirmed, otp });
        if (result.error) return failEmail(result.error, "We could not verify that code. Please try again.");
        close();
        setNotice(hasEmail ? "Email changed." : "Email added.");
        router.refresh();
      } catch {
        setError(CONNECTION_FAILED);
      }
    });
  };

  const disconnect = () => start(async () => {
    setError("");
    setStale(false);
    try {
      const confirmation = await confirmUnlinkTelegram();
      if (!confirmation.ok) return failTelegram(confirmation.code, "We could not confirm this. Please try again.");
      const result = await memberAuthClient.unlinkAccount({ accountId: confirmation.accountId });
      if (result.error) return failTelegram(result.error.code, "We could not disconnect Telegram. Please try again.");
      close();
      // The unlink hook revokes the consent in the same operation; the switch agrees before the refresh lands.
      setBot(false);
      setNotice("Telegram disconnected.");
      router.refresh();
    } catch {
      setError(CONNECTION_FAILED);
    }
  });

  const connect = () => start(async () => {
    setError("");
    setStale(false);
    try {
      const confirmation = await confirmLinkTelegram();
      if (!confirmation.ok) return failTelegram(confirmation.code, "We could not confirm this. Please try again.");
      // The auth client follows the returned Telegram URL; the callback lands
      // back on this page with the outcome, so the button stays "Opening
      // Telegram…" until the browser leaves.
      const result = await memberAuthClient.linkSocial({ provider: "telegram", callbackURL: "/hq/account?connected=telegram", errorCallbackURL: "/hq/account?error=telegram" });
      if (result.error) return failTelegram(result.error.code, "We could not start the Telegram connection. Please try again.");
      setLeaving(true);
    } catch {
      setError(CONNECTION_FAILED);
    }
  });

  // The switch flips at once and is put back if the write fails.
  const toggleBot = (next: boolean) => {
    if (switchPending || next === bot) return;
    const previous = bot;
    setBot(next);
    setSwitchError("");
    startSwitch(async () => {
      try {
        const result = await setBotMessaging(next);
        if (!result.ok) {
          setBot(previous);
          setSwitchError(telegramErrorMessage(result.code) ?? "We could not save this. Please try again.");
          return;
        }
        setBot(result.enabled);
        router.refresh();
        // Save consent before leaving HQ. Same-tab navigation also works
        // after an async save on mobile, where a popup may be blocked.
        if (next && result.enabled && props.botUrl) window.location.assign(props.botUrl);
      } catch {
        setBot(previous);
        setSwitchError(CONNECTION_FAILED);
      }
    });
  };

  return (
    <div className={styles.main}>
      <Link href="/hq/dashboard" className={styles.home}><IconArrowLeft width={16} height={16} fill="currentColor" aria-hidden="true" />Home</Link>
      <div className={styles.layout}>
        <div className={styles.column}>
          <h1 className={styles.title}>Your account</h1>
          {notice && <p role="status" className={styles.notice}>{notice}</p>}
          {pageError && <p role="alert" className={styles.pageError}>{pageError}</p>}
          <div className={styles.rows}>
            {emailAvailable && (
              <button type="button" className={styles.row} aria-haspopup="dialog" onClick={(event) => openModal("email", event)}>{hasEmail ? "Change email" : "Add a recovery email"}{arrow}</button>
            )}
            {hasTelegram && hasEmail && (
              <button type="button" className={styles.row} aria-haspopup="dialog" onClick={(event) => openModal("disconnect", event)}>Disconnect Telegram{arrow}</button>
            )}
            {hasTelegram && !hasEmail && (
              <span aria-disabled="true" className={styles.rowBlocked}>Disconnect Telegram<span className={styles.rowHint}>Add an email first</span></span>
            )}
            {!hasTelegram && telegramAvailable && (
              <button type="button" className={`${styles.row} ${styles.rowFilled}`} aria-haspopup="dialog" onClick={(event) => openModal("connect", event)}>Connect Telegram{arrow}</button>
            )}
          </div>
        </div>
        <div className={styles.card}>
          <div>
            <p className={styles.kicker}>{role}</p>
            <p className={styles.name}>{name}</p>
          </div>
          <dl className={styles.facts}>
            <dt>Email</dt><dd className={styles.factEmail}>{email ?? "None"}</dd>
            <dt>Telegram</dt><dd>{telegram ? (telegram.username ? `@${telegram.username}` : "Connected") : "Not connected"}</dd>
            <dt>Team</dt><dd>{teamName ?? "None"}</dd>
          </dl>
          {hasTelegram && (
            <div>
              <label className={styles.switchRow}>
                <span>Bot reminders on Telegram</span>
                <span className={styles.switchTarget}>
                  {!bot && <svg className={styles.switchArrows} width="60" height="80" viewBox="0 0 60 80" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 8Q32 8 50 28m-11-2 11 2-2-11" />
                    <path d="M3 40h49m-9-8 9 8-9 8" />
                    <path d="M5 72Q32 72 50 52m-11 2 11-2-2 11" />
                  </svg>}
                  <input type="checkbox" className={styles.switchInput} checked={bot} disabled={switchPending} aria-busy={switchPending} onChange={(event) => toggleBot(event.target.checked)} />
                  <span aria-hidden="true" className={`${styles.switchTrack} ${bot ? styles.switchTrackOn : ""}`}><span className={styles.switchKnob} /></span>
                </span>
              </label>
              {!bot && props.botUrl && <p className={styles.switchHint}>Turning this on opens the bot chat.</p>}
              <TelegramBotStart botUrl={props.botUrl} inverse />
              {switchError && <p role="alert" className={styles.switchError}>{switchError}</p>}
            </div>
          )}
        </div>
      </div>
      {modal && (
        <AccountModal
          kind={modal}
          hasEmail={hasEmail}
          step={step}
          draft={draft}
          confirmed={confirmed}
          otp={otp}
          pending={pending}
          leaving={leaving}
          secondsLeft={secondsLeft}
          error={error}
          stale={stale}
          start={start}
          onClose={close}
          onDraftChange={(value) => { setDraft(value); setError(""); }}
          onOtpChange={setOtp}
          onSendCode={sendCode}
          onVerify={verify}
          onDisconnect={disconnect}
          onConnect={connect}
          onStaleError={setError}
        />
      )}
    </div>
  );
}

export type AccountModalProps = {
  kind: Modal;
  hasEmail: boolean;
  step: Step;
  draft: string;
  confirmed: string;
  otp: string;
  pending: boolean;
  /** The Telegram URL was returned and the browser is leaving. */
  leaving: boolean;
  secondsLeft: number;
  error: string;
  /** The last refusal was SESSION_NOT_FRESH: offer the way out. */
  stale: boolean;
  start: TransitionStartFunction;
  onClose: () => void;
  onDraftChange: (value: string) => void;
  /** Receives the digits only, at most six of them. */
  onOtpChange: (digits: string) => void;
  onSendCode: (event?: FormEvent<HTMLFormElement>) => void;
  onVerify: (event: FormEvent<HTMLFormElement>) => void;
  onDisconnect: () => void;
  onConnect: () => void;
  onStaleError: (message: string) => void;
};

/** The modal's markup alone, with the state passed in, so a static render can check each step. Overlay click and Cancel close; a click inside stays inside. */
export function AccountModal({ kind, hasEmail, step, draft, confirmed, otp, pending, leaving, secondsLeft, error, stale, start, onClose, onDraftChange, onOtpChange, onSendCode, onVerify, onDisconnect, onConnect, onStaleError }: AccountModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef);
  const title = kind === "email" ? (hasEmail ? "Change email" : "Add email") : kind === "disconnect" ? "Disconnect Telegram?" : "Connect Telegram";
  const cancel = <button type="button" className={styles.cancel} onClick={onClose}>Cancel</button>;
  return (
    <div className={styles.overlay} onClick={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="ac-modal-title" tabIndex={-1} className={styles.dialog} onClick={(event) => event.stopPropagation()}>
        <h2 id="ac-modal-title" className={styles.dialogTitle}>{title}</h2>
        {kind === "email" && step === "email" && (
          <form className={styles.form} onSubmit={onSendCode}>
            <input type="email" className={styles.input} value={draft} onChange={(event) => onDraftChange(event.target.value)} autoComplete="email" required autoFocus aria-label="Email" placeholder={hasEmail ? "New email" : "Email"} />
            <div className={styles.buttons}>
              <button type="submit" className={styles.primary} disabled={pending}>{pending ? "Sending…" : "Send code"}</button>
              {cancel}
            </div>
          </form>
        )}
        {kind === "email" && step === "code" && (
          <form className={styles.form} onSubmit={onVerify}>
            <p className={styles.sentTo}>Code sent to <strong>{confirmed}</strong></p>
            <input type="text" className={`${styles.input} ${styles.otp}`} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(event) => onOtpChange(event.target.value.replace(/\D/g, "").slice(0, 6))} autoFocus aria-label="6-digit code" placeholder="6-digit code" />
            <div className={`${styles.buttons} ${styles.buttonsCentered}`}>
              <button type="submit" className={`${styles.primary} ${styles.verify}`} disabled={pending || otp.length !== 6}>{pending ? "Checking…" : "Verify"}</button>
              <ResendCodeButton className={styles.resend} secondsLeft={secondsLeft} disabled={pending} onClick={() => onSendCode()} />
            </div>
          </form>
        )}
        {kind === "disconnect" && (
          <>
            <p className={styles.dialogText}>You will sign in with your email only. Bot reminders stop.</p>
            <div className={styles.buttons}>
              <button type="button" className={styles.danger} disabled={pending} onClick={onDisconnect}>Disconnect</button>
              {cancel}
            </div>
          </>
        )}
        {kind === "connect" && (
          <>
            <p className={styles.dialogText}>Opens Telegram. Approve there and you are back here.</p>
            <div className={styles.buttons}>
              <button type="button" className={styles.primary} disabled={pending || leaving} onClick={onConnect}>{pending || leaving ? "Opening Telegram…" : "Open Telegram"}</button>
              {cancel}
            </div>
          </>
        )}
        {error && <p role="alert" className={styles.alert}>{error}</p>}
        {stale && <SignInAgain next={HERE} start={start} disabled={pending} onError={onStaleError} />}
      </div>
    </div>
  );
}
