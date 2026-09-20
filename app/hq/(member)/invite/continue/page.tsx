import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BuilderShell } from "@/components/hq/builder-shell";
import styles from "@/components/hq/builder-shell.module.css";
import { builderDatabase } from "@/lib/hq/builder-db";
import { getTelegramIdentity } from "@/lib/hq/identity";
import { INVITE_CONTINUATION_COOKIE, readInviteContinuation } from "@/lib/hq/invite-continuation";
import { currentMember } from "@/lib/hq/member-auth";
import { getTelegramBotUrl } from "@/lib/hq/member-auth-config";
import { INVITE_CONTINUE_PATH } from "@/lib/hq/member-routes";
import { getBotConsent } from "@/lib/hq/telegram-consent";
import { INVITE_INTRO, inviteOutcomeCopy, type InviteOutcome } from "../copy";
import { AcceptInvitationForm } from "./accept-form";

export const metadata: Metadata = { title: "Captain invitation" };
export const dynamic = "force-dynamic";

/** The shared shape for every dead-end outcome this page can show before anyone has clicked Accept: not-found, revoked, expired or full. */
function DeadEnd({ outcome }: { outcome: InviteOutcome }) {
  const copy = inviteOutcomeCopy(outcome);
  return (
    <BuilderShell>
      <h1>
        {copy.heading} <em>{copy.emphasis}</em>
      </h1>
      <p role="alert" className={styles.error}>{copy.body}</p>
    </BuilderShell>
  );
}

/**
 * Step 2 of the Captain invitation flow: the tokenless page the exchange
 * step (app/hq/(member)/invite/[token]/route.ts) redirects to. Reachable by
 * anyone, signed in or not: the invitation is explained here, and only
 * `AcceptInvitationForm`'s own Server Action ever grants anything.
 *
 * currentMember() is the literal member gate this page carries
 * (tests/hq/auth-boundary.test.ts); it never redirects a signed-out visitor
 * away, because they must see this same explanation and a way back here
 * after signing in. Nothing member-specific renders without it: a signed-out
 * visitor gets the explanation and a sign-in link, never the accept control.
 *
 * The explanation goes into the form as children rather than beside it, so
 * it leaves the page together with the Accept button once a result has
 * replaced them; the shell renders no avatar for a signed-out visitor on
 * its own.
 */
export default async function InviteContinuePage() {
  const member = await currentMember();
  const continuationId = (await cookies()).get(INVITE_CONTINUATION_COOKIE)?.value;
  const continuation = continuationId ? await readInviteContinuation(builderDatabase(), continuationId) : null;

  if (!continuation) return <DeadEnd outcome="not-found" />;

  // A best-effort snapshot from the exchange step, not re-read here: showing
  // it costs no extra query over the invitation tables, and whatever it
  // says, AcceptInvitationForm's submit always gets the authoritative
  // outcome from acceptCaptainInvitation's own row lock.
  const blocked = continuation.revoked ? "revoked" : continuation.expired ? "expired" : continuation.full ? "full" : null;
  if (blocked) return <DeadEnd outcome={blocked} />;

  // A new email account still needs a name, but returns to this invitation
  // afterward, never to the builder's team initialization flow.
  if (member && !member.name.trim()) redirect(`/hq/profile?next=${encodeURIComponent(INVITE_CONTINUE_PATH)}`);

  const telegram = member ? await getTelegramIdentity(member.id) : null;
  const consent = member && telegram ? await getBotConsent(member.id) : null;

  return (
    <BuilderShell>
      <h1>
        Become a <em>Captain.</em>
      </h1>
      {member ? (
        <AcceptInvitationForm
          hasTelegram={telegram !== null}
          botEnabled={telegram !== null && (consent?.messagingEnabled ?? true)}
          botUrl={getTelegramBotUrl()}
        >
          <p>{INVITE_INTRO}</p>
        </AcceptInvitationForm>
      ) : (
        <>
          <p>{INVITE_INTRO}</p>
          <div className={styles.actions}>
            <Link className={styles.button} href={`/hq/login?next=${encodeURIComponent(INVITE_CONTINUE_PATH)}`}>
              Log in or sign up
            </Link>
          </div>
        </>
      )}
    </BuilderShell>
  );
}
