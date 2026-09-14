import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { BuilderShell } from "@/components/hq/builder-shell";
import styles from "@/components/hq/builder-shell.module.css";
import { builderDatabase } from "@/lib/hq/builder-db";
import { INVITE_CONTINUATION_COOKIE, readInviteContinuation } from "@/lib/hq/invite-continuation";
import { currentMember } from "@/lib/hq/member-auth";
import { INVITE_CONTINUE_PATH } from "@/lib/hq/member-routes";
import { inviteOutcomeCopy, type InviteOutcome } from "../copy";
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
 * anyone, signed in or not — the invitation is explained here, and only
 * `AcceptInvitationForm`'s own Server Action ever grants anything.
 *
 * currentMember() is the literal member gate this page carries
 * (tests/hq/auth-boundary.test.ts); it never redirects a signed-out visitor
 * away, because they must see this same explanation and a way back here
 * after signing in. Nothing member-specific renders without it: a signed-out
 * visitor gets the explanation and a sign-in link, never the accept control.
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

  return (
    <BuilderShell>
      <h1>
        Become a <em>Captain.</em>
      </h1>
      <p>
        Accepting gives your HQ account Captain access — and nothing else. It grants no admin access and no project
        assignment; an admin assigns your team separately, and nothing about your existing teams or roles changes.
      </p>
      {member ? (
        <AcceptInvitationForm />
      ) : (
        <div className={styles.actions}>
          <Link className={styles.button} href={`/hq/signin?next=${encodeURIComponent(INVITE_CONTINUE_PATH)}`}>
            Sign in to continue
          </Link>
        </div>
      )}
    </BuilderShell>
  );
}
