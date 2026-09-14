import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BuilderShell } from "@/components/hq/builder-shell";
import styles from "@/components/hq/builder-shell.module.css";
import { requireMemberActor } from "@/lib/hq/actor";

export const metadata: Metadata = { title: "Captain" };
export const dynamic = "force-dynamic";

// The captain module. The gate is the member session, then the capability
// read from the grants for this request, never the menu that led here: an
// account without the grant gets the same not-found page as a URL that does
// not exist. Assignments arrive in phase 4.
export default async function CaptainPage() {
  const actor = await requireMemberActor("/hq/captain");
  if (!actor.capabilities.has("captain")) notFound();
  return (
    <BuilderShell>
      <h1>Your <em>assignments.</em></h1>
      <p>No assignments yet. Assignments appear here once an admin assigns you a team.</p>
      {!actor.telegram && (
        <section className={styles.notice} aria-labelledby="captain-telegram">
          <h2 id="captain-telegram">Connect Telegram</h2>
          <p>Captains can use the HQ bot on Telegram for reminders and updates once it is ready. Connecting is optional and never changes your account, your teams or your roles.</p>
          <Link className={styles.button} href="/hq/account">Connect Telegram</Link>
        </section>
      )}
    </BuilderShell>
  );
}
