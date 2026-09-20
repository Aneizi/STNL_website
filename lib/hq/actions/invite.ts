"use server";

import { refreshHq } from "../revalidation";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireMemberActor } from "../actor";
import { builderDatabase } from "../builder-db";
import { acceptCaptainInvitation, type AcceptCaptainInvitationResult } from "../captains";
import { INVITE_CONTINUATION_COOKIE, readInviteContinuation } from "../invite-continuation";
import { INVITE_CONTINUE_PATH } from "../member-routes";
import { setBotConsent, TelegramNotConnectedError } from "../telegram-consent";

// The member half of the Captain invitation flow; lib/hq/actions/captains.ts
// is the operator half (creating and revoking links) and stays
// operator-gated. This lives in its own module rather than alongside that
// file because tests/hq/operator-imports.test.ts fails an operator action
// module that transitively reaches lib/hq/member-auth.ts, and
// requireMemberActor() below does exactly that. A dedicated member-gated
// action module, with its own entry in both tests/hq/auth-boundary.test.ts's
// ACTION_GATES and tests/hq/operator-imports.test.ts's MEMBER_ACTIONS, is the
// same shape lib/hq/actions/telegram.ts already uses for the other
// member-only actions.

export type AcceptCaptainInvitationOutcome = AcceptCaptainInvitationResult["outcome"] | "invalid-continuation";
export type AcceptCaptainInvitationActionResult = {
  outcome: AcceptCaptainInvitationOutcome;
  botError?: "not-connected" | "save-failed";
};

/**
 * The only write path for a Captain invitation redemption reachable from the
 * public web: an explicit POST, gated on a real, verified member session,
 * over the continuation the exchange step
 * (app/hq/(member)/invite/[token]/route.ts) recorded — never a token or an
 * invitation id from a form field or a query string.
 *
 * No redeemability pre-check: acceptCaptainInvitation locks the invitation
 * row and decides everything itself. A second submission (a double click, a
 * retried request) reaches it again and gets "already-redeemed" back,
 * consuming no further slot — the same idempotence
 * tests/hq/captains.test.ts already proves at the service level.
 */
export async function acceptCaptainInvitationFromContinuation(
  _previous: AcceptCaptainInvitationActionResult | null,
  formData: FormData,
): Promise<AcceptCaptainInvitationActionResult> {
  const actor = await requireMemberActor(INVITE_CONTINUE_PATH);
  const continuationId = (await cookies()).get(INVITE_CONTINUATION_COOKIE)?.value;
  const continuation = continuationId ? await readInviteContinuation(builderDatabase(), continuationId) : null;
  if (!continuation) return { outcome: "invalid-continuation" };
  const result = await acceptCaptainInvitation(builderDatabase(), { invitationId: continuation.invitationId, userId: actor.id });
  // The Captains' Den is capability-driven (the actor's grants, read on every
  // request); this only clears the cached route tree so the next navigation
  // picks the new grant up immediately, the same revalidation
  // lib/hq/actions/builders.ts does for its own member mutations.
  if (["granted", "already-captain", "already-redeemed"].includes(result.outcome)) {
    refreshHq("captains");
    // Only a fresh acceptance saves the submitted preference. Retried or old
    // forms must not overwrite a decision the captain later made in Account.
    if (result.outcome === "granted" && formData.get("botMessagingPreference") === "included") {
      try {
        await setBotConsent(actor, formData.get("botMessaging") === "on");
      } catch (error) {
        // Captain access has already been granted. Keep that success visible
        // and let the member recover the optional reminder setting in Account.
        return { outcome: result.outcome, botError: error instanceof TelegramNotConnectedError ? "not-connected" : "save-failed" };
      }
    }
    redirect(result.outcome === "granted" ? "/hq/dashboard?welcome=captain" : "/hq/dashboard");
  }
  return { outcome: result.outcome };
}
