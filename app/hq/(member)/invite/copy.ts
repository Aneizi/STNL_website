import type { AcceptCaptainInvitationOutcome } from "@/lib/hq/actions/invite";

// Copy for every outcome the Captain invitation flow can land on, shared by
// the continuation page's pre-acceptance snapshot (revoked/expired/full/
// not-found only) and the accept form's post-submit result (the full
// union). One table so the two never drift apart, and so "not-found" (the
// exchange step found no matching token) and "invalid-continuation" (this
// page found no valid continuation) read identically: a visitor is never
// told which case it was.
//
// A member never sees who created a link, who else redeemed it, its
// internal label or its exact remaining capacity (lib/hq/captains.ts's
// CaptainInvitationRedeemability deliberately carries none of that); this
// copy names only the account's own outcome.

export type InviteOutcome = AcceptCaptainInvitationOutcome;

export type InviteOutcomeCopy = { heading: string; emphasis: string; body: string; tone: "good" | "bad" };

/** What accepting does, shown while the invitation is still open, to a signed-in and a signed-out visitor alike. */
export const INVITE_INTRO =
  "Accepting gives your HQ account Captain access. It grants no admin access and no project assignment; an admin assigns your team separately, and nothing about your existing teams or roles changes.";

const NOT_FOUND: InviteOutcomeCopy = {
  heading: "Invitation",
  emphasis: "not found.",
  tone: "bad",
  body: "This invitation link is not one we recognise. Ask the admin who sent it for a fresh one.",
};

const COPY: Record<InviteOutcome, InviteOutcomeCopy> = {
  granted: {
    heading: "You are now a",
    emphasis: "Captain.",
    tone: "good",
    body: "Captain access is on your account. An admin will assign your team; until then the Captain page shows no assignments.",
  },
  "already-redeemed": {
    heading: "Already",
    emphasis: "accepted.",
    tone: "good",
    body: "You already accepted this invitation. Your HQ account has Captain access.",
  },
  "already-captain": {
    heading: "Already a",
    emphasis: "Captain.",
    tone: "good",
    body: "Your HQ account already has Captain access, from elsewhere. This invitation has nothing new to give it.",
  },
  revoked: {
    heading: "Invitation",
    emphasis: "revoked.",
    tone: "bad",
    body: "This invitation was withdrawn by an admin. Nothing on your account has changed.",
  },
  expired: {
    heading: "Invitation",
    emphasis: "expired.",
    tone: "bad",
    body: "This invitation has passed its expiry. Ask the admin who sent it for a fresh one.",
  },
  full: {
    heading: "Invitation",
    emphasis: "used up.",
    tone: "bad",
    body: "Every seat on this invitation has been taken. Ask the admin who sent it for a fresh one.",
  },
  unverified: {
    heading: "Verify your",
    emphasis: "account.",
    tone: "bad",
    body: "Add a verified email or connect Telegram to your HQ account, then use this link again.",
  },
  "not-found": NOT_FOUND,
  "no-profile": {
    heading: "Almost",
    emphasis: "there.",
    tone: "bad",
    body: "Your account is still finishing setup. Try this link again in a moment.",
  },
  "invalid-continuation": NOT_FOUND,
};

export function inviteOutcomeCopy(outcome: InviteOutcome): InviteOutcomeCopy {
  return COPY[outcome];
}
