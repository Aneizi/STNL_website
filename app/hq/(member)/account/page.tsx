import type { Metadata } from "next";
import Link from "next/link";
import { BuilderShell } from "@/components/hq/builder-shell";
import styles from "@/components/hq/builder-shell.module.css";
import { requireMemberActor } from "@/lib/hq/actor";
import { getLoginMethods } from "@/lib/hq/identity";
import { getMemberAuthAvailability } from "@/lib/hq/member-auth-config";
import { lastParam, telegramErrorMessage } from "../telegram-copy";

export const metadata: Metadata = { title: "Your account" };
export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Everything shown here comes from the server: the actor and
// getLoginMethods(), which never yield the internal placeholder address.
// Nothing on this page reads the auth client's session object.
export default async function AccountPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const actor = await requireMemberActor("/hq/account");
  const methods = await getLoginMethods(actor.id);
  const telegramAvailable = getMemberAuthAvailability().telegram;
  const error = telegramErrorMessage(lastParam(params.error), "connect");
  const notice = lastParam(params.connected) === "telegram" ? "Telegram connected." : lastParam(params.disconnected) === "telegram" ? "Telegram disconnected." : null;
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
        {methods.email
          ? <p>{methods.email.address}{methods.email.verified ? "" : " (not verified)"}</p>
          : <p>None. This account signs in with Telegram only.</p>}
      </section>

      <section className={styles.card} aria-labelledby="account-telegram">
        <h2 id="account-telegram">Telegram</h2>
        {methods.telegram ? (
          <>
            <span className={styles.status}>Connected{methods.telegram.username ? ` as @${methods.telegram.username}` : ""}</span>
            {lastLoginMethod ? (
              <>
                <p id="disconnect-blocked">Telegram is the only way to sign in to this account, so it cannot be disconnected. Add a verified email first.</p>
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
            {telegramAvailable ? (
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
    </BuilderShell>
  );
}
