"use server";

import { z } from "zod";
import type { Actor } from "../actor";
import { requireUser, type HqUser } from "../auth";
import { loadEntry, loadProjectEdition } from "../authz-sql";
import { builderDatabase } from "../builder-db";
import { BuilderError } from "../builder-types";
import { requireHackathon } from "../hackathon";
import {
  correctOutcome,
  enableReporting,
  ensureReportingPeriods,
  listPeriodOutcomes,
  listReportingPeriods,
  pauseReporting,
  previewReportingPeriods,
  readAuthorizedUpdates,
  readReportingSchedule,
  readRevisionHistory,
  reportingStatus,
  voidUpdate,
  writeReportingConfig,
  type PeriodOutcome,
  type PeriodStatus,
  type ReportingEntryView,
  type ReportingPeriodPlan,
  type ReportingRevision,
} from "../reporting";
import { zonedDateTimeToUtc } from "../reporting-periods";
import type { ActionResult } from "../types";
import { inHackathon, refreshHq } from "./util";

/**
 * The admin side of weekly reporting: moderation, historical correction,
 * eligibility, the schedule and the detail-panel reads behind Projects.
 *
 * Operator gated, so this module must stay clear of the public member auth
 * graph (`tests/hq/operator-imports.test.ts`). That is why phase 6 split the
 * session-free half of ./authz into ./authz-decisions: `lib/hq/reporting.ts`
 * now reaches neither ./actor nor ./member-auth, so the one reporting service
 * can be called from here as well as from the member actions, rather than
 * being copied for operators.
 *
 * It is also why the operator `Actor` is built below from `requireUser()`
 * instead of `requireOperatorActor()`: that function lives in ./actor, which
 * imports the member session. The gate is the same one every other operator
 * action uses, and `operatorActor` is only the shape conversion after it.
 *
 * Every record action resolves its id through `inHackathon`, so a project id
 * or a period id from another edition answers exactly like one that does not
 * exist.
 */

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const reasonSchema = z.string().trim().min(3).max(500);
/** What a `datetime-local` field submits: a wall clock with no offset. The seconds a browser may append are ignored. */
const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/;
/** The same fallback `readReportingSchedule` uses when an edition has no timezone setting of its own. */
const CAMPAIGN_TIMEZONE_FALLBACK = "Europe/Amsterdam";
/** How many updates, and how many saved versions, one admin read returns before the rest go behind a cursor. */
const ADMIN_PAGE = 50;
const REVISION_PAGE = 25;

/** The authenticated operator as the reporting service takes them. The gate is the `requireUser()` its caller already ran. */
const operatorActor = (user: HqUser): Actor => ({ kind: "operator", id: user.id, displayName: user.displayName });

/** The project when it belongs to the edition being shown, else null. */
async function projectInEdition(projectId: string, hackathonId: number) {
  const edition = await loadProjectEdition(builderDatabase(), projectId);
  return inHackathon(edition, hackathonId);
}

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
}): Promise<ActionResult> {
  await requireUser();
  const hackathon = await requireHackathon();
  const parsed = z
    .object({
      finalPeriodStartDate: z.union([isoDate, z.literal("")]),
      officialSubmissionDeadline: z.string().max(40),
      nudgeWeekday: z.number().int().min(1).max(7),
      nudgeTime: z.string().regex(/^\d{2}:\d{2}$/),
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
  await writeReportingConfig(builderDatabase(), {
    hackathonId: hackathon.id,
    finalPeriodStartDate: parsed.data.finalPeriodStartDate || null,
    officialSubmissionDeadline: deadlineParts ? zonedDateTimeToUtc(deadlineParts[1], deadlineParts[2], timezone).toISOString() : null,
    nudgeWeekday: parsed.data.nudgeWeekday,
    nudgeTime: parsed.data.nudgeTime,
  });
  refreshHq();
  return { ok: true };
}

/** Puts a project the admin tracks manually into weekly reporting. Idempotent, and it never moves an existing start. */
export async function enableProjectReporting(projectId: string): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  if (!uuid.safeParse(projectId).success) return { ok: false, error: "That project is no longer there." };
  if (!(await projectInEdition(projectId, hackathon.id))) return { ok: false, error: "That project is no longer there." };
  const result = await enableReporting(builderDatabase(), { projectId, hackathonId: hackathon.id, operatorId: user.id });
  if (!result.ok) return { ok: false, error: "That project is no longer there." };
  refreshHq();
  return { ok: true };
}

/** Pauses or resumes a project's future weeks. Weeks already recorded stay exactly as they were recorded. */
export async function setProjectReportingPaused(input: { projectId: string; paused: boolean; reason?: string }): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  const parsed = z.object({ projectId: uuid, paused: z.boolean(), reason: z.string().trim().max(500).optional() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "That project is no longer there." };
  if (!(await projectInEdition(parsed.data.projectId, hackathon.id))) return { ok: false, error: "That project is no longer there." };
  const result = await pauseReporting(builderDatabase(), {
    projectId: parsed.data.projectId,
    hackathonId: hackathon.id,
    paused: parsed.data.paused,
    operatorId: user.id,
    reason: parsed.data.reason || undefined,
  });
  if (!result.ok) return { ok: false, error: "That project is not in weekly reporting." };
  refreshHq();
  return { ok: true };
}

/**
 * Admin moderation of one update: it stops counting toward the week and
 * stops being readable, and nothing is deleted. Its saved versions stay for
 * the history, and the audit event records the reason and the ids, never the
 * text.
 */
export async function voidReportingUpdate(input: { entryId: string; reason: string }): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  const parsed = z.object({ entryId: uuid, reason: reasonSchema }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Say why this update is being removed, in a few words." };
  const entry = inHackathon(await loadEntry(builderDatabase(), parsed.data.entryId), hackathon.id);
  if (!entry) return { ok: false, error: "That update is no longer there." };
  const result = await voidUpdate(operatorActor(user), parsed.data);
  if (!result.ok) {
    return { ok: false, error: result.reason === "already_voided" ? "That update was already removed." : "That update is no longer there." };
  }
  refreshHq();
  return { ok: true };
}

/**
 * An admin's correction of a week that was recorded wrongly. The original
 * outcome is never rewritten: the correction is written beside it with the
 * mandatory reason and an audit event, and both stay readable.
 */
export async function correctReportingOutcome(input: {
  periodId: string;
  projectId: string;
  completed: boolean;
  reason: string;
}): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  const parsed = z.object({ periodId: uuid, projectId: uuid, completed: z.boolean(), reason: reasonSchema }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Say why this week is being corrected, in a few words." };
  if (!(await projectInEdition(parsed.data.projectId, hackathon.id))) return { ok: false, error: "That project is no longer there." };
  const periods = await listReportingPeriods(builderDatabase(), hackathon.id);
  if (!periods.some((period) => period.id === parsed.data.periodId)) return { ok: false, error: "That week is not part of this hackathon." };
  const result = await correctOutcome(operatorActor(user), { ...parsed.data, operatorId: user.id });
  if (!result.ok) {
    return {
      ok: false,
      error: result.reason === "unchanged"
        ? "That week already reads the way you asked for."
        : "That week has no recorded outcome to correct yet.",
    };
  }
  refreshHq();
  return { ok: true };
}

export type ProjectReportingDetail = {
  projectId: string;
  /** Every week of the edition with this project's state in it, newest first on screen. */
  history: PeriodStatus[];
  entries: ReportingEntryView[];
  /** Where the next page of updates starts, or null at the end. The panel's Load more carries it back through `loadMoreProjectUpdates`. */
  entriesCursor: string | null;
  /** The persisted outcomes of the weeks that have been closed, so a correction shows what was recorded and what it now reads as. */
  outcomes: PeriodOutcome[];
  /** Whether the project is in reporting at all, so the panel offers Add to reporting rather than an empty list. */
  enrolled: boolean;
  paused: boolean;
  missedPeriods: number;
  current: PeriodStatus | null;
};

/**
 * Everything the Projects detail panel shows about one project's reporting,
 * read on demand rather than for every row on the board. Operators see every
 * entry, sensitive and voided included, which is what the permission contract
 * gives them and what makes this an operator action rather than a wider read.
 *
 * The weeks come from `reportingStatus` with `includeHistory`, the one
 * dashboard read, rather than from a second completion rule of this module's
 * own. The stored outcomes are fetched only for the weeks that have actually
 * been closed, because those are the only ones that have any.
 */
export async function loadProjectReporting(projectId: string): Promise<
  { ok: true; detail: ProjectReportingDetail } | { ok: false; error: string }
> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  if (!uuid.safeParse(projectId).success) return { ok: false, error: "That project is no longer there." };
  if (!(await projectInEdition(projectId, hackathon.id))) return { ok: false, error: "That project is no longer there." };
  const db = builderDatabase();
  const actor = operatorActor(user);
  const [statuses, page] = await Promise.all([
    reportingStatus(db, { hackathonId: hackathon.id, projectIds: [projectId], includeHistory: true }),
    readAuthorizedUpdates(actor, { projectId, hackathonId: hackathon.id, limit: ADMIN_PAGE }),
  ]);
  const status = statuses[0];
  const closed = (status?.history ?? []).filter((period) => period.closed);
  const outcomes = (await Promise.all(closed.map((period) => listPeriodOutcomes(db, period.periodId))))
    .flat()
    .filter((outcome) => outcome.projectId === projectId);
  return {
    ok: true,
    detail: {
      projectId,
      history: status?.history ?? [],
      entries: page.entries,
      entriesCursor: page.nextCursor,
      outcomes,
      enrolled: Boolean(status),
      paused: Boolean(status?.paused),
      missedPeriods: status?.missedPeriods ?? 0,
      current: status?.current ?? null,
    },
  };
}

/**
 * The next page of one project's updates. The panel starts at
 * `loadProjectReporting`'s first page and continues here, rather than stopping
 * at the first page and discarding the cursor: an admin's "full history"
 * stopped being full the moment a project passed fifty updates.
 */
export async function loadMoreProjectUpdates(input: { projectId: string; cursor: string }): Promise<
  { ok: true; entries: ReportingEntryView[]; nextCursor: string | null } | { ok: false; error: string }
> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  const parsed = z.object({ projectId: uuid, cursor: z.string().max(200) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "That project is no longer there." };
  if (!(await projectInEdition(parsed.data.projectId, hackathon.id))) return { ok: false, error: "That project is no longer there." };
  const page = await readAuthorizedUpdates(operatorActor(user), {
    projectId: parsed.data.projectId, hackathonId: hackathon.id, limit: ADMIN_PAGE, cursor: parsed.data.cursor,
  });
  return { ok: true, entries: page.entries, nextCursor: page.nextCursor };
}

/**
 * One update's saved versions, a page at a time. Operators only, per the
 * permission contract; a member never sees a prior version at all.
 *
 * `afterVersion` is the version the caller already has, and the table's own
 * `(entry_id, version)` key is the cursor, so the panel can walk an entry with
 * more than a hundred versions instead of silently stopping at the service
 * default. Bodies stay here and are never joined into a list read.
 */
export async function loadEntryRevisions(entryId: string, afterVersion = 0): Promise<
  { ok: true; revisions: ReportingRevision[]; nextAfterVersion: number | null } | { ok: false; error: string }
> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  const parsed = z.object({ entryId: uuid, afterVersion: z.number().int().min(0).max(1_000_000) }).safeParse({ entryId, afterVersion });
  if (!parsed.success) return { ok: false, error: "That update is no longer there." };
  const entry = inHackathon(await loadEntry(builderDatabase(), parsed.data.entryId), hackathon.id);
  if (!entry) return { ok: false, error: "That update is no longer there." };
  const revisions = await readRevisionHistory(operatorActor(user), {
    entryId: parsed.data.entryId, afterVersion: parsed.data.afterVersion, limit: REVISION_PAGE,
  });
  const last = revisions[revisions.length - 1];
  return { ok: true, revisions, nextAfterVersion: revisions.length === REVISION_PAGE && last ? last.version : null };
}
