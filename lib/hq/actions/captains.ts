"use server";

import { z } from "zod";
import { requireUser } from "../auth";
import { builderDatabase } from "../builder-db";
import { BuilderError } from "../builder-types";
import {
  createCaptainInvitation as createCaptainInvitationRecord,
  revokeCaptainInvitation as revokeCaptainInvitationRecord,
  type CaptainInvitationListing,
} from "../captains";
import type { ActionResult } from "../types";
import { refreshHq } from "./util";

// Operator actions over Captain invitations (lib/hq/captains.ts). Like its
// neighbour ../actions/capabilities.ts, a Captain grant is account-global, so
// nothing here reads the hackathon cookie. Accepting an invitation is a
// member action and lives in lib/hq/captains.ts#acceptCaptainInvitation
// instead — task T4.3 calls it from the public /hq/invite/<token> route, not
// from here.

const createSchema = z.object({
  label: z.string().trim().max(200).optional(),
  // Shape only: the sane upper bound and the future/finite expiry rule are
  // enforced once, in createCaptainInvitation itself, and surfaced below
  // through its BuilderError message.
  maxRedemptions: z.coerce.number().int().min(1),
  expiresInDays: z.coerce.number().positive(),
});

/**
 * The one exception to ActionResult in this file: creating an invitation
 * must return its plaintext token, which exists in this response and
 * nowhere else. A distinct type rather than a bent ActionResult so a caller
 * cannot mistake the two shapes.
 */
export type CreateCaptainInvitationResult = { ok: true; token: string; invitation: CaptainInvitationListing } | { ok: false; error: string };

/** Creates a Captain invitation and returns its link once. Copy it now — refreshing Admin never shows it again. */
export async function createCaptainInvitation(input: { label?: string; maxRedemptions: number; expiresInDays: number }): Promise<CreateCaptainInvitationResult> {
  const user = await requireUser();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Give a valid label, account limit and duration." };
  try {
    const created = await createCaptainInvitationRecord(builderDatabase(), {
      actorOperatorId: user.id,
      label: parsed.data.label || null,
      maxRedemptions: parsed.data.maxRedemptions,
      expiresInDays: parsed.data.expiresInDays,
    });
    refreshHq();
    return { ok: true, token: created.token, invitation: created.invitation };
  } catch (error) {
    if (error instanceof BuilderError) return { ok: false, error: error.message };
    throw error;
  }
}

const revokeSchema = z.object({ invitationId: z.string().uuid() });

/** Revokes future redemption of an invitation. Accounts that already redeemed it keep Captain access; revoke those individually instead. */
export async function revokeCaptainInvitation(invitationId: string): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = revokeSchema.safeParse({ invitationId });
  if (!parsed.success) return { ok: false, error: "Unknown invitation." };
  try {
    const revoked = await revokeCaptainInvitationRecord(builderDatabase(), { actorOperatorId: user.id, invitationId: parsed.data.invitationId });
    if (!revoked) return { ok: false, error: "This invitation was already revoked or does not exist." };
  } catch (error) {
    if (error instanceof BuilderError) return { ok: false, error: error.message };
    throw error;
  }
  refreshHq();
  return { ok: true };
}
