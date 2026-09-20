"use server";

import { z } from "zod";
import { ColosseumApiError, fetchEditionSubmissionWindow } from "@/lib/colosseum-api";
import { requireUser } from "../auth";
import { builderDatabase } from "../builder-db";
import { builderStore } from "../builder-store";
import { BuilderError } from "../builder-types";
import { requireHackathon } from "../hackathon";
import {
  ensureReportingPeriods,
  previewReportingPeriods,
  readAuthorizedUpdates,
  readReportingSchedule,
  recordColosseumDeadline,
  writeReportingConfig,
  type ReportingPeriodPlan,
  type ReportingEntryPage,
} from "../reporting";
import { isCalendarDate, zonedDateTimeToUtc } from "../reporting-periods";
import { isMaterialKey } from "../submission-readiness";
import type { ActionResult } from "../types";
import { refreshHq } from "./util";

/**
 * The admin side of weekly reporting: the schedule and the reporting
 * settings behind the Admin page.
 *
 * Operator gated, so this module must stay clear of the public member auth
 * graph (`tests/hq/operator-imports.test.ts`). That is why phase 6 split the
 * session-free half of ./authz into ./authz-decisions: `lib/hq/reporting.ts`
 * reaches neither ./actor nor ./member-auth, so the one reporting service
 * can be called from here as well as from the member actions, rather than
 * being copied for operators. The gate is the same `requireUser()` every
 * other operator action uses.
 */

const isoDate = z.string().refine(isCalendarDate);
/** What a `datetime-local` field submits: a wall clock with no offset. The seconds a browser may append are ignored. */
const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/;
/** The same fallback `readReportingSchedule` uses when an edition has no timezone setting of its own. */
const CAMPAIGN_TIMEZONE_FALLBACK = "Europe/Amsterdam";
/** The floor on automatic submission checks, matching the CHECK constraint on the column. */
const MIN_SUBMISSION_REFRESH_MINUTES = 15;

export type ProjectUpdatesResult =
  | { ok: true; page: ReportingEntryPage }
  | { ok: false; error: string };

/** Reporting history for an expanded admin project, scoped to the selected edition. */
export async function loadProjectReportingUpdates(input: {
  projectId: string;
  cursor?: string;
}): Promise<ProjectUpdatesResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  const parsed = z.object({ projectId: z.string().uuid(), cursor: z.string().max(200).optional() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Could not load updates for this project." };
  const db = builderDatabase();
  // Operators can read every edition through the service; this screen is scoped to one.
  const { rows } = await db.query("SELECT 1 FROM hq_projects WHERE id=$1::uuid AND hackathon_id=$2", [parsed.data.projectId, hackathon.id]);
  if (!rows.length) return { ok: true, page: { entries: [], nextCursor: null } };
  const page = await readAuthorizedUpdates(
    { kind: "operator", id: user.id, displayName: user.displayName },
    { ...parsed.data, hackathonId: hackathon.id, limit: 10 },
    db,
  );
  return { ok: true, page };
}

/**
 * Why HQ could not read the edition's deadline, one sentence per cause. The
 * same rule imports follow: no failure collapses into a generic message, and
 * Colosseum's own words are never shown.
 */
const DEADLINE_READ_MESSAGES: Record<string, string> = {
  INVALID_URL: "That Colosseum edition id is not one we can ask about.",
  NOT_FOUND: "Colosseum does not know that edition id. Check it under Builder onboarding.",
  RATE_LIMITED: "Colosseum asked us to slow down. Try again in a few minutes.",
  TIMED_OUT: "Colosseum did not answer in time. Try again in a moment.",
  UNREACHABLE: "We could not reach Colosseum. Try again in a moment.",
  INVALID_RESPONSE: "Colosseum answered with something we could not read.",
  SOURCE_REJECTED: "Colosseum refused the request. Its project directory for this edition is most likely still closed.",
  UNAVAILABLE: "Colosseum is not answering right now. Try again in a moment.",
  WRONG_HACKATHON: "Colosseum answered about a different edition.",
};

export type ReportingScheduleView = {
  hackathonId: number;
  plan: ReportingPeriodPlan;
};

/**
 * What reconciling the stored periods with the edition's current dates would
 * do, with nothing written: the plan's "show affected periods before an admin
 * changes a live schedule". A period that already holds an update or a
 * recorded week, or that has been closed, comes back as a conflict rather
 * than being moved, and the screen shows those before Apply is offered.
 */
export async function previewReportingSchedule(): Promise<{ ok: true; schedule: ReportingScheduleView } | { ok: false; error: string }> {
  await requireUser();
  const hackathon = await requireHackathon();
  const plan = await previewReportingPeriods(builderDatabase(), hackathon.id);
  return { ok: true, schedule: { hackathonId: hackathon.id, plan } };
}

/**
 * Writes the previewed change.
 *
 * Conflicts come back again, because `ensureReportingPeriods` refuses to move
 * those weeks either, and so does `blocked`: a change that would leave a day
 * belonging to no week, or to two, is refused as a whole rather than half
 * applied, and the screen says which weeks it fell between. The counts still
 * describe the change that was refused, so the sentence an admin reads is
 * about what they asked for.
 */
export async function applyReportingSchedule(): Promise<{ ok: true; schedule: ReportingScheduleView } | { ok: false; error: string }> {
  await requireUser();
  const hackathon = await requireHackathon();
  let plan;
  try {
    plan = await ensureReportingPeriods(builderDatabase(), hackathon.id);
  } catch (error) {
    // The one error the service raises here is the guarded write finding
    // someone reported against a week mid-apply, which rolls the whole
    // transaction back. It has a sentence of its own; anything else does not.
    if (error instanceof BuilderError) return { ok: false, error: error.message };
    throw error;
  }
  refreshHq();
  return { ok: true, schedule: { hackathonId: hackathon.id, plan } };
}

/**
 * The edition's reporting settings. Saving them changes what the schedule
 * would generate but never the stored periods: the admin previews and then
 * applies, which is the whole point of the two steps.
 */
export async function saveReportingConfiguration(input: {
  finalPeriodStartDate: string;
  officialSubmissionDeadline: string;
  nudgeWeekday: number;
  nudgeTime: string;
  /** Phase 10: which submission materials this edition asks for. Anything in neither list stays Unknown on every screen. */
  requiredMaterials?: string[];
  optionalMaterials?: string[];
  /** Minutes between automatic submission checks during the final period. Empty or zero turns them off. */
  submissionRefreshMinutes?: number | null;
}): Promise<ActionResult> {
  await requireUser();
  const hackathon = await requireHackathon();
  const materials = z.array(z.string().max(60)).max(20).optional();
  const parsed = z
    .object({
      finalPeriodStartDate: z.union([isoDate, z.literal("")]),
      officialSubmissionDeadline: z.string().max(40),
      nudgeWeekday: z.number().int().min(1).max(7),
      nudgeTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      requiredMaterials: materials,
      optionalMaterials: materials,
      submissionRefreshMinutes: z.number().int().min(0).max(10_080).nullish(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the reporting settings and try again." };
  // The deadline is typed as a wall clock with no offset (the `datetime-local`
  // input has none to give), so the zone it is read in has to be named
  // explicitly. `new Date(value)` would read it in the SERVER's zone, which
  // means the same typed value stores a different instant depending on where
  // the process runs: "2026-10-12T23:59" entered by an Amsterdam admin
  // becomes 23:59 UTC on a UTC host, two hours past the deadline they meant.
  // The campaign timezone is the one every other time-of-day decision here
  // already uses, and the form shows and takes the value in it.
  const schedule = await readReportingSchedule(builderDatabase(), hackathon.id);
  const timezone = schedule?.timezone ?? CAMPAIGN_TIMEZONE_FALLBACK;
  const deadline = parsed.data.officialSubmissionDeadline.trim();
  const deadlineParts = LOCAL_DATE_TIME.exec(deadline);
  if (deadline && !deadlineParts) {
    return { ok: false, error: "That submission deadline is not a date and time we can read." };
  }
  if (schedule && parsed.data.finalPeriodStartDate
    && (parsed.data.finalPeriodStartDate < schedule.startDate || parsed.data.finalPeriodStartDate > schedule.endDate)) {
    return { ok: false, error: "The final period must start within this hackathon's reporting dates." };
  }
  let officialSubmissionDeadline: string | null = null;
  try {
    if (deadlineParts) officialSubmissionDeadline = zonedDateTimeToUtc(deadlineParts[1], deadlineParts[2], timezone).toISOString();
  } catch {
    return { ok: false, error: "That submission deadline is not a valid date and time." };
  }
  // An interval below the column's floor would be a rate-limit incident
  // rather than a setting, so it is refused here with its own sentence rather
  // than by the CHECK constraint. Zero and empty both mean off.
  const refresh = parsed.data.submissionRefreshMinutes;
  if (refresh != null && refresh > 0 && refresh < MIN_SUBMISSION_REFRESH_MINUTES) {
    return { ok: false, error: `Automatic submission checks cannot run more often than every ${MIN_SUBMISSION_REFRESH_MINUTES} minutes.` };
  }
  // An unrecognised material key is dropped rather than refused: the arrays
  // are configuration, and a key left behind by a renamed material must not
  // make the whole form unsaveable.
  const keys = (values: string[] | undefined) => (values === undefined ? undefined : values.filter(isMaterialKey));
  await writeReportingConfig(builderDatabase(), {
    hackathonId: hackathon.id,
    finalPeriodStartDate: parsed.data.finalPeriodStartDate || null,
    officialSubmissionDeadline,
    nudgeWeekday: parsed.data.nudgeWeekday,
    nudgeTime: parsed.data.nudgeTime,
    ...(keys(parsed.data.requiredMaterials) !== undefined ? { requiredMaterials: keys(parsed.data.requiredMaterials) } : {}),
    ...(keys(parsed.data.optionalMaterials) !== undefined ? { optionalMaterials: keys(parsed.data.optionalMaterials) } : {}),
    ...(refresh !== undefined ? { submissionRefreshMinutes: refresh ? refresh : null } : {}),
  });
  refreshHq();
  return { ok: true };
}

/**
 * Reads the edition's own submission deadline from Colosseum and records it.
 *
 * `fetchEditionSubmissionWindow` is phase 3's one reader of
 * `projectSubmissionEndDate`, and this is its first production caller. It
 * asks about the EXTERNAL edition id an admin configured under Builder
 * onboarding; there is no constant here and none anywhere else.
 *
 * Every failure keeps its own sentence, the rule imports have followed since
 * phase 3, and none of them erases what is already stored: an edition whose
 * project directory is still disabled answers 400, which is a fact about
 * Colosseum's directory and not about the deadline an admin may already have
 * typed in.
 */
export async function readColosseumDeadline(): Promise<{ ok: true; deadline: string | null } | { ok: false; error: string }> {
  await requireUser();
  const hackathon = await requireHackathon();
  const edition = await builderStore().hackathon(hackathon.id);
  if (edition.externalId == null) {
    return { ok: false, error: "Set this hackathon's Colosseum edition id under Builder onboarding first." };
  }
  const checkedAt = new Date().toISOString();
  try {
    const window = await fetchEditionSubmissionWindow(edition.externalId);
    const config = await recordColosseumDeadline(builderDatabase(), {
      hackathonId: hackathon.id,
      deadline: window?.submissionEnd ?? null,
      checkedAt,
    });
    refreshHq();
    if (!window) return { ok: false, error: "Colosseum does not list that edition, so it has no submission deadline to read." };
    if (!window.submissionEnd) return { ok: false, error: "Colosseum lists that edition but has not published a submission deadline for it yet." };
    return { ok: true, deadline: config.officialSubmissionDeadline };
  } catch (error) {
    if (error instanceof ColosseumApiError) {
      await recordColosseumDeadline(builderDatabase(), { hackathonId: hackathon.id, deadline: null, checkedAt });
      refreshHq();
      return { ok: false, error: DEADLINE_READ_MESSAGES[error.code] };
    }
    throw error;
  }
}
