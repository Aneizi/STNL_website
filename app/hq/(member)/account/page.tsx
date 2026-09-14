import type { Metadata } from "next";
import Link from "next/link";
import { BuilderShell } from "@/components/hq/builder-shell";
import styles from "@/components/hq/builder-shell.module.css";
import { requireMemberActor } from "@/lib/hq/actor";
import { getLoginMethods } from "@/lib/hq/identity";
import { getMemberAuthAvailability } from "@/lib/hq/member-auth-config";
import { getBotConsent } from "@/lib/hq/telegram-consent";
import { LAST_LOGIN_METHOD_COPY, lastParam, telegramErrorMessage } from "../telegram-copy";
import { BotMessagingToggle } from "./bot-messaging-toggle";

export const metadata: Metadata = { title: "Your account" };
export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Everything shown here comes from the server: the actor, getLoginMethods(),
// which never yields the internal placeholder address, and the stored
// bot-messaging decision. Nothing on this page reads the auth client's
// session object.
export default async function AccountPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const actor = await requireMemberActor("/hq/account");
  const methods = await getLoginMethods(actor.id);
  const availability = getMemberAuthAvailability();
  // Consent is read only when there is a Telegram to message; it is never inferred from the connection.
  const consent = methods.telegram ? await getBotConsent(actor.id) : null;
  const botMessages = consent?.messagingEnabled ?? false;
  const error = telegramErrorMessage(params.error, "connect");
  // The added-email notice is shown only when it is true of this account: a real address next to a Telegram connection.
  const notice = lastParam(params.connected) === "telegram"
    ? "Telegram connected."
    : lastParam(params.disconnected) === "telegram"
      ? "Telegram disconnected."
      : lastParam(params.email) === "added" && methods.email && methods.telegram
        ? "Email added. You can now sign in with it as well as with Telegram."
        : null;
  // actor.email is the verified login email (null for Telegram-only accounts),
  // the same value the plugin's last-login-method rule is defined over.
  const lastLoginMethod = actor.email === null;

  return (
    <BuilderShell back="/hq/dashboard">
      <h1>Your <em>account.</em></h1>
      <p>The ways you can sign in to Superteam NL HQ. Adding or removing one never changes your account, your teams or your roles.</p>
      {notice && <p role="status" className={styles.success}>{notice}</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}

      <section className={styles.card} aria-labelledby="account-email">
        <h2 id="account-email">Email</h2>
        {methods.email ? (
          <p>{methods.email.address}{methods.email.verified ? "" : " (not verified)"}</p>
        ) : (
          <>
            <p>None. This account signs in with Telegram only.</p>
            {availability.email ? (
              <>
                <p>A verified email lets you sign in without Telegram and is the way back in if you ever lose access to it.</p>
                <Link className={styles.button} href="/hq/account/add-email">Add a recovery email</Link>
              </>
            ) : (
              <p>Email is not available yet.</p>
            )}
          </>
        )}
      </section>

      <section className={styles.card} aria-labelledby="account-telegram">
        <h2 id="account-telegram">Telegram</h2>
        {methods.telegram ? (
          <>
            <span className={styles.status}>Connected{methods.telegram.username ? ` as @${methods.telegram.username}` : ""}</span>
            {lastLoginMethod ? (
              <>
                <p id="disconnect-blocked">{LAST_LOGIN_METHOD_COPY}</p>
                <button type="button" className={styles.secondary} disabled aria-describedby="disconnect-blocked">Disconnect Telegram</button>
              </>
            ) : (
              <>
                <p>You can sign in with Telegram or with your email.</p>
                <Link className={styles.secondary} href="/hq/account/disconnect-telegram">Disconnect Telegram</Link>
              </>
            )}
          </>
        ) : (
          <>
            <span className={styles.status}>Not connected</span>
            {availability.telegram ? (
              <>
                <p>Connect Telegram to sign in with it as well as with your email.</p>
                <Link className={styles.button} href="/hq/account/connect-telegram">Connect Telegram</Link>
              </>
            ) : (
              <p>Telegram sign-in is not available yet.</p>
            )}
          </>
        )}
      </section>

      {methods.telegram && (
        <section className={styles.card} aria-labelledby="account-bot">
          <h2 id="account-bot">Bot messages</h2>
          <span className={styles.status}>{botMessages ? "Enabled" : "Disabled"}</span>
          <p>
            {botMessages
              ? "HQ can send you Wednesday reminders on Telegram. Disable this at any time."
              : "HQ can send you Wednesday reminders on Telegram only when this is enabled. Being connected does not turn it on."}
            {" "}Your website access is the same either way.
          </p>
          <BotMessagingToggle enabled={botMessages} />
        </section>
      )}
    </BuilderShell>
  );
}
