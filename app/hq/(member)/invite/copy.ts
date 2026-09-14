import type { AcceptCaptainInvitationOutcome } from "@/lib/hq/actions/invite";

// Copy for every outcome the Captain invitation flow can land on, shared by
// the continuation page's pre-acceptance snapshot (revoked/expired/full/
// not-found only) and the accept form's post-submit result (the full
// union). One table so the two never drift apart, and so "not-found" (the
// exchange step found no matching token) and "invalid-continuation" (this
// page found no valid continuation) read identically — a visitor is never
// told which case it was.
//
// A member never sees who created a link, who else redeemed it, its
// internal label or its exact remaining capacity (lib/hq/captains.ts's
// CaptainInvitationRedeemability deliberately carries none of that); this
// copy names only the account's own outcome.

export type InviteOutcome = AcceptCaptainInvitationOutcome;

export type InviteOutcomeCopy = { heading: string; emphasis: string; body: string; tone: "good" | "bad" };

const COPY: Record<InviteOutcome, InviteOutcomeCopy> = {
  granted: {
    heading: "You're a",
    emphasis: "Captain.",
    tone: "good",
    body: "Your HQ account now has Captain access. The Captain menu item appears the next time you load a page. An admin assigns your team separately — this does not change your existing teams or roles.",
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
    body: "Whoever sent this link has revoked it. Ask them for a new one.",
  },
  expired: {
    heading: "Invitation",
    emphasis: "expired.",
    tone: "bad",
    body: "This invitation is past its expiry. Ask whoever sent it for a new one.",
  },
  full: {
    heading: "Invitation",
    emphasis: "full.",
    tone: "bad",
    body: "This invitation has reached its limit and is no longer accepting new Captains. Ask whoever sent it for a new one.",
  },
  unverified: {
    heading: "Verify your",
    emphasis: "account.",
    tone: "bad",
    body: "Add a verified email or connect Telegram to your HQ account, then use this link again.",
  },
  "not-found": {
    heading: "Invalid",
    emphasis: "link.",
    tone: "bad",
    body: "This invitation link isn't valid. It may be mistyped or out of date. Ask whoever sent it for a new one.",
  },
  "no-profile": {
    heading: "Almost",
    emphasis: "there.",
    tone: "bad",
    body: "Your account is still finishing setup. Try this link again in a moment.",
  },
  "invalid-continuation": {
    heading: "Invalid",
    emphasis: "link.",
    tone: "bad",
    body: "This invitation link isn't valid. It may be mistyped or out of date. Ask whoever sent it for a new one.",
  },
};

export function inviteOutcomeCopy(outcome: InviteOutcome): InviteOutcomeCopy {
  return COPY[outcome];
}
