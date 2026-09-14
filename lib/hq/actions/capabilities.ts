"use server";

import { z } from "zod";
import { requireUser } from "../auth";
import { builderDatabase } from "../builder-db";
import { BuilderError } from "../builder-types";
import { grantCapability, revokeCapability } from "../capabilities";
import { clearCaptainAssignments } from "../captains";
import type { ActionResult } from "../types";
import { refreshHq } from "./util";

// Operator actions over admin-controlled account capabilities. The actor id
// comes from requireUser() and nowhere else; the account id and the reason
// are the only inputs. Here the operator is both the acting actor and the
// `granted_by`; a member-initiated grant (phase 4's invitation redemption)
// passes a member actor instead.
//
// Grants are account-global, so nothing here reads the hackathon cookie and,
// unlike its neighbour updateBuilderTier in ./builders-admin.ts, nothing
// requires the account to hold a People card in the selected edition: an
// account that loses its card keeps the capability until it is revoked.

const inputSchema = z.object({
  userId: z.string().min(1).max(200),
  reason: z.string().trim().min(3).max(500),
});

const INVALID: ActionResult = { ok: false, error: "Give a reason of at least 3 characters." };

function failure(error: unknown): ActionResult {
  if (error instanceof BuilderError) return { ok: false, error: error.message };
  throw error;
}

/** Grants Captain to a public account. Repeating it for an account that already holds it changes nothing. */
export async function grantCaptainCapability(userId: string, reason: string): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = inputSchema.safeParse({ userId, reason });
  if (!parsed.success) return INVALID;
  try {
    await grantCapability(builderDatabase(), { actor: { kind: "operator", id: user.id }, byOperatorId: user.id, ...parsed.data, capability: "captain" });
  } catch (error) {
    return failure(error);
  }
  refreshHq();
  return { ok: true };
}

/**
 * Revokes Captain from a public account. Ends the grant and clears every
 * project it currently captains, in the same transaction — "removing
 * Captain access must clear or reassign affected projects in the same
 * controlled operation": if either half fails, both roll back together.
 * grantCaptainCapability/revokeCaptainCapability are the only actions that
 * ever touch hq_captain_assignments outside lib/hq/actions/captains.ts's own
 * assignment actions, and only through clearCaptainAssignments.
 *
 * The admin sees the affected project count *before* confirming — Admin
 * reads it with `countAssignmentsForCaptain` (lib/hq/builder-admin-queries.ts
 * batches it into `BuilderAccount.captainAssignmentCount`) and puts it in the
 * confirmation copy (components/hq/builder-admin.tsx); this action does not
 * report the count back, by design (`ActionResult` stays the return type).
 */
export async function revokeCaptainCapability(userId: string, reason: string): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = inputSchema.safeParse({ userId, reason });
  if (!parsed.success) return INVALID;
  try {
    const revoked = await builderDatabase().transaction(async (tx) => {
      const grant = await revokeCapability(tx, { actor: { kind: "operator", id: user.id }, byOperatorId: user.id, ...parsed.data, capability: "captain" });
      if (!grant) return null;
      await clearCaptainAssignments(tx, { actor: { kind: "operator", id: user.id }, byOperatorId: user.id, captainUserId: parsed.data.userId, reason: parsed.data.reason });
      return grant;
    });
    if (!revoked) return { ok: false, error: "This account does not hold Captain access." };
  } catch (error) {
    return failure(error);
  }
  refreshHq();
  return { ok: true };
}
