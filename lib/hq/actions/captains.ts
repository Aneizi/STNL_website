"use server";

import { z } from "zod";
import { requireUser } from "../auth";
import { builderDatabase } from "../builder-db";
import { BuilderError } from "../builder-types";
import {
  assignCaptain as assignCaptainRecord,
  createCaptainInvitation as createCaptainInvitationRecord,
  revokeCaptainInvitation as revokeCaptainInvitationRecord,
  unassignCaptain as unassignCaptainRecord,
  type AssignCaptainResult,
  type CaptainConflictReason,
  type CaptainInvitationListing,
} from "../captains";
import { requireHackathon } from "../hackathon";
import type { ActionResult } from "../types";
import { refreshHq } from "./util";

// Operator actions over Captain invitations and assignment (lib/hq/captains.ts).
// Like its neighbour ../actions/capabilities.ts, a Captain *grant* is
// account-global, so invitation actions read no hackathon cookie. An
// *assignment* is edition-scoped by the project it names, so the assignment
// actions below resolve the operator's selected edition through
// requireHackathon() the same way lib/hq/actions/projects.ts does, and pass
// it straight to the service rather than trusting a client-supplied id.
// Accepting an invitation is a member action and lives in
// lib/hq/captains.ts#acceptCaptainInvitation instead — task T4.3 calls it
// from the public /hq/invite/<token> route, not from here. Assignment has no
// member-facing counterpart at all: Captains cannot self-assign.

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

// --- Assignment (task T4.4) -------------------------------------------------
//
// The client contract is deliberately narrower than AssignCaptainResult: a
// picker only ever needs to know whether it worked, whether it needs a
// second, explicit confirmation over unresolved roster identity, or why it
// failed. Everything else (which conflict source, an orphaned-row defensive
// case) collapses into one operator-facing message here, once, instead of a
// switch the client would otherwise have to repeat at every call site.
export type AssignCaptainActionResult =
  | { outcome: "assigned" }
  | { outcome: "needs_review"; unresolved: Array<{ name: string; username: string | null }> }
  | { outcome: "error"; error: string };

function conflictMessage(conflict: CaptainConflictReason): string {
  switch (conflict.kind) {
    case "verified_member":
      return conflict.role === "owner"
        ? "This account is this project's verified owner. Change that relationship, or choose a different Captain."
        : "This account is a verified member of this project's team. Change that relationship, or choose a different Captain.";
    case "roster_member":
      return `This account is linked to ${conflict.memberUsername ? `${conflict.memberName} (@${conflict.memberUsername})` : conflict.memberName} on this project's imported roster.`;
    case "already_assigned":
      return "This project was just given a Captain by someone else. Reload and try again.";
  }
}

function toAssignActionResult(result: AssignCaptainResult): AssignCaptainActionResult {
  switch (result.outcome) {
    case "assigned":
      return { outcome: "assigned" };
    case "needs_review":
      return { outcome: "needs_review", unresolved: result.unresolved.map((member) => ({ name: member.name, username: member.username })) };
    case "no_grant":
      return { outcome: "error", error: "This account does not currently hold an active Captain grant." };
    case "not_found":
      return { outcome: "error", error: "This project is not available in the selected hackathon." };
    case "conflict":
      return { outcome: "error", error: conflictMessage(result.conflict) };
  }
}

const assignSchema = z.object({
  projectId: z.string().uuid(),
  captainUserId: z.string().min(1).max(200),
  reason: z.string().trim().max(500).optional(),
  acknowledgeUnresolved: z.boolean().optional(),
});

/**
 * Assigns (or reassigns) a project's current Captain. `acknowledgeUnresolved`
 * is the second call of a two-step confirmation: the first call over an
 * unresolved roster identity writes nothing and returns `needs_review`
 * naming the rows; only a caller that explicitly passes `true` after seeing
 * that list can push the assignment through. Never true by default, and
 * never inferred from anything but an explicit operator action.
 */
export async function assignProjectCaptain(input: z.infer<typeof assignSchema>): Promise<AssignCaptainActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  const parsed = assignSchema.safeParse(input);
  if (!parsed.success) return { outcome: "error", error: "Choose a project and a Captain." };
  try {
    const result = await assignCaptainRecord(builderDatabase(), {
      actorOperatorId: user.id,
      projectId: parsed.data.projectId,
      hackathonId: hackathon.id,
      captainUserId: parsed.data.captainUserId,
      reason: parsed.data.reason,
      acknowledgeUnresolved: parsed.data.acknowledgeUnresolved,
    });
    if (result.outcome === "assigned") refreshHq();
    return toAssignActionResult(result);
  } catch (error) {
    if (error instanceof BuilderError) return { outcome: "error", error: error.message };
    throw error;
  }
}

const unassignSchema = z.object({ projectId: z.string().uuid() });

/** Removes a project's current Captain. Idempotent: a project with none already is not an error. */
export async function unassignProjectCaptain(projectId: string): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  const parsed = unassignSchema.safeParse({ projectId });
  if (!parsed.success) return { ok: false, error: "Unknown project." };
  try {
    const result = await unassignCaptainRecord(builderDatabase(), { actorOperatorId: user.id, projectId: parsed.data.projectId, hackathonId: hackathon.id });
    if (result.outcome === "not_found") return { ok: false, error: "This project is not available in the selected hackathon." };
    // "not_assigned" is also ok: true (idempotent, nothing to remove), but
    // nothing changed, so — unlike a real "unassigned" — there is nothing
    // for a page to re-render.
    if (result.outcome === "unassigned") refreshHq();
  } catch (error) {
    if (error instanceof BuilderError) return { ok: false, error: error.message };
    throw error;
  }
  return { ok: true };
}

const bulkAssignSchema = z.object({
  projectIds: z.array(z.string().uuid()).min(1).max(200),
  captainUserId: z.string().min(1).max(200),
  reason: z.string().trim().max(500).optional(),
  acknowledgeUnresolved: z.boolean().optional(),
});

export type BulkAssignCaptainOutcome = { projectId: string; result: AssignCaptainActionResult };

/**
 * Assigns one Captain to several projects. Each project is its own
 * transaction (assignCaptainRecord), run in sequence and reported
 * individually: a project that conflicts is named in the results, not
 * silently skipped, and the projects before and after it are unaffected —
 * there is no batch-wide rollback to skip past.
 */
export async function bulkAssignProjectCaptain(input: z.infer<typeof bulkAssignSchema>): Promise<BulkAssignCaptainOutcome[]> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  const parsed = bulkAssignSchema.safeParse(input);
  if (!parsed.success) return [];
  const db = builderDatabase();
  const outcomes: BulkAssignCaptainOutcome[] = [];
  let anyAssigned = false;
  for (const projectId of parsed.data.projectIds) {
    try {
      const result = await assignCaptainRecord(db, {
        actorOperatorId: user.id,
        projectId,
        hackathonId: hackathon.id,
        captainUserId: parsed.data.captainUserId,
        reason: parsed.data.reason,
        acknowledgeUnresolved: parsed.data.acknowledgeUnresolved,
      });
      if (result.outcome === "assigned") anyAssigned = true;
      outcomes.push({ projectId, result: toAssignActionResult(result) });
    } catch (error) {
      outcomes.push({ projectId, result: { outcome: "error", error: error instanceof BuilderError ? error.message : "We could not save this. Please try again." } });
    }
  }
  if (anyAssigned) refreshHq();
  return outcomes;
}
