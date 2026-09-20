"use server";

import { z } from "zod";
import { requireUser } from "../auth";
import { builderDatabase } from "../builder-db";
import { BuilderError } from "../builder-types";
import { grantCapability, revokeCapability } from "../capabilities";
import { clearCaptainAssignments } from "../captains";
import type { ActionResult } from "../types";
import { refreshHq } from "./util";

// The authenticated operator is both the actor and granted_by identity.
// Grants are account-global: losing a People card does not revoke a capability.

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
  refreshHq("captains");
  return { ok: true };
}

/** Revocation and clearing the Captain's assignments must commit or roll back together. */
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
  refreshHq("captains");
  return { ok: true };
}
