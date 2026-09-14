"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireMemberActor } from "../actor";
import { getActorCapabilities } from "../authz";
import { builderDatabase } from "../builder-db";
import { authorizedTeam, TEAM_NOT_AVAILABLE } from "../member-teams";
import {
  MAX_CONTACT_LENGTH,
  normalizeContact,
  writeCaptainContact,
  writeTeamContact,
} from "../reporting-contacts";
import {
  createUpdate,
  editUpdate,
  MAX_BODY_LENGTH,
  type ReportingEntryView,
  type ReportingPeriod,
} from "../reporting";
import { ADD_UPDATE_MESSAGES, EDIT_UPDATE_MESSAGES } from "../reporting-view";

/**
 * The member side of weekly reporting: the team page's and the Captain
 * page's writes, and nothing else. Thin callers, as the plan requires
 * ("Web actions and bot handlers should remain thin callers of these
 * services"): every rule about what completes a week, who may mark a note
 * sensitive, what a late entry does and whether an edit is still current is
 * enforced inside `lib/hq/reporting.ts`, over facts read in its own
 * transaction. Nothing is re-decided here.
 *
 * Authorization is the service's too. `createUpdate` and `editUpdate` call
 * `authorizeProjectAction` and `canEditEntry` themselves, which is what makes
 * them safe to share with the Telegram bot in phase 7; adding a second check
 * here would be a second rule, and a weaker one, because a Captain's assigned
 * project has no `BuilderTeam` to look up at all. The two contact actions
 * below are different: they touch a team record rather than a reporting one,
 * so they go through `authorizedTeam` like every other team write.
 *
 * Two refusals carry data because the screen has a real answer for them, not
 * a generic error:
 *
 * - `period_changed` means the draft was bound to a week that closed while it
 *   was being written. The service names the week that is open now, and the
 *   composer asks before moving the text into it.
 * - `conflict` means the entry changed under an edit. The service hands back
 *   the version that is saved now, and the composer keeps the unsaved text
 *   beside it rather than discarding it.
 */

const uuid = z.string().uuid();
const hackathonIdSchema = z.number().int().positive();
const bodySchema = z.string().max(MAX_BODY_LENGTH + 1);
const visibilitySchema = z.enum(["shared", "sensitive"]);
const contactSchema = z.string().max(MAX_CONTACT_LENGTH + 50);

function refresh() {
  revalidatePath("/hq", "layout");
}

export type AddUpdateInput = {
  projectId: string;
  hackathonId: number;
  body: string;
  visibility?: "shared" | "sensitive";
  /** The period the composer was opened against, so a save that crossed midnight is caught rather than silently moved. */
  expectedPeriodId?: string;
};

export type AddUpdateResult =
  | { ok: true; entry: ReportingEntryView; completesPeriod: boolean }
  | { ok: false; reason: "period_changed"; error: string; currentPeriod: ReportingPeriod | null }
  | { ok: false; reason: Exclude<keyof typeof ADD_UPDATE_MESSAGES, "period_changed">; error: string };

/** Adds one update to the open week, or to the week the composer was opened against. */
export async function addReportingUpdate(input: AddUpdateInput): Promise<AddUpdateResult> {
  const actor = await requireMemberActor();
  const parsed = z
    .object({
      projectId: uuid,
      hackathonId: hackathonIdSchema,
      body: bodySchema,
      visibility: visibilitySchema.optional(),
      expectedPeriodId: uuid.optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, reason: "not_authorized", error: ADD_UPDATE_MESSAGES.not_authorized };

  const result = await createUpdate(actor, { ...parsed.data, source: "hq" });
  if (result.ok) {
    refresh();
    return { ok: true, entry: result.entry, completesPeriod: result.completesPeriod };
  }
  if (result.reason === "period_changed") {
    return { ok: false, reason: "period_changed", error: ADD_UPDATE_MESSAGES.period_changed, currentPeriod: result.currentPeriod ?? null };
  }
  return { ok: false, reason: result.reason, error: ADD_UPDATE_MESSAGES[result.reason] };
}

export type EditUpdateActionInput = {
  entryId: string;
  body?: string;
  visibility?: "shared" | "sensitive";
  expectedVersion: number;
  /** Required to move a sensitive note back to shared, so the wider audience is an explicit choice. */
  confirmAudienceChange?: boolean;
};

export type EditUpdateActionResult =
  | { ok: true; entry: ReportingEntryView; changed: boolean }
  | { ok: false; reason: "conflict"; error: string; current: ReportingEntryView | null }
  | { ok: false; reason: Exclude<keyof typeof EDIT_UPDATE_MESSAGES, "conflict">; error: string };

/** Edits an update the caller wrote, while they are still authorized on its project. */
export async function editReportingUpdate(input: EditUpdateActionInput): Promise<EditUpdateActionResult> {
  const actor = await requireMemberActor();
  const parsed = z
    .object({
      entryId: uuid,
      body: bodySchema.optional(),
      visibility: visibilitySchema.optional(),
      expectedVersion: z.number().int().positive(),
      confirmAudienceChange: z.boolean().optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, reason: "not_found", error: EDIT_UPDATE_MESSAGES.not_found };

  const result = await editUpdate(actor, parsed.data);
  if (result.ok) {
    refresh();
    return { ok: true, entry: result.entry, changed: result.changed };
  }
  if (result.reason === "conflict") {
    return { ok: false, reason: "conflict", error: EDIT_UPDATE_MESSAGES.conflict, current: result.current ?? null };
  }
  return { ok: false, reason: result.reason, error: EDIT_UPDATE_MESSAGES[result.reason] };
}

export type ContactResult = { ok: true; contact: string | null } | { ok: false; error: string };

/**
 * The team's preferred contact, set by the team lead. `membership.change` is
 * the right action for it: it is the team's own shared detail, the same
 * permission that picks the team lead and creates a join link, and a Captain
 * holds no Captain-only permission there.
 */
export async function saveTeamContact(input: { projectId: string; hackathonId: number; contact: string }): Promise<ContactResult> {
  const actor = await requireMemberActor();
  const parsed = z.object({ projectId: uuid, hackathonId: hackathonIdSchema, contact: contactSchema }).safeParse(input);
  if (!parsed.success) return { ok: false, error: TEAM_NOT_AVAILABLE };
  const team = await authorizedTeam(actor, { projectId: parsed.data.projectId, hackathonId: parsed.data.hackathonId, action: "membership.change" });
  if (!team) return { ok: false, error: TEAM_NOT_AVAILABLE };
  const contact = normalizeContact(parsed.data.contact);
  const written = await writeTeamContact(builderDatabase(), team.id, contact);
  if (!written) return { ok: false, error: TEAM_NOT_AVAILABLE };
  refresh();
  return { ok: true, contact };
}

/**
 * The contact a Captain approves for the teams they are assigned to. Gated on
 * the capability read for this request, never on the menu that led here: an
 * account without it is answered the same way an unrelated team is.
 */
export async function saveCaptainContact(input: { contact: string }): Promise<ContactResult> {
  const actor = await requireMemberActor();
  // The grant as it stands now, not the set the actor was built with: that
  // one is for the menu, and ./authz reads the grants again at decision time.
  if (!(await getActorCapabilities(actor)).has("captain")) return { ok: false, error: TEAM_NOT_AVAILABLE };
  const parsed = z.object({ contact: contactSchema }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the contact and try again." };
  const contact = normalizeContact(parsed.data.contact);
  const written = await writeCaptainContact(builderDatabase(), actor.id, contact);
  if (!written) return { ok: false, error: "We could not save this. Please try again." };
  refresh();
  return { ok: true, contact };
}
