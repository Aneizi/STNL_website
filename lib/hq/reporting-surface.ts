import "server-only";
import type { MemberActor } from "./actor";
import { builderDatabase, type BuilderQuery } from "./builder-db";
import { listAssignments } from "./captains";
import { submittedOnTime } from "./colosseum-snapshot";
import { readCaptainHandle, readTeamContacts } from "./reporting-contacts";
import {
  listReportingPeriods,
  readAuthorizedUpdates,
  readCaptainUpdatePages,
  readReportingConfig,
  readReportingSchedule,
  reportingStatus,
  type PeriodStatus,
  type ProjectReportingStatus,
  type ReportingEntryView,
} from "./reporting";
import { periodForInstant } from "./reporting-periods";
import {
  isOpenSubmissionPeriod,
  readSubmissionReconciliations,
  readSubmissionSnapshots,
  submissionDeadlineFor,
  type ProjectSubmissionSnapshot,
  type SubmissionReconciliation,
} from "./submission";
import {
  materialRequirements,
  submissionChecklist,
  type ChecklistItem,
} from "./submission-readiness";

/**
 * What the two member reporting screens read, composed once here rather than
 * twice in two pages.
 *
 * Everything comes from the reporting service: the weeks from
 * `reportingStatus` (the one dashboard read, never looped per project), the
 * entries from `readAuthorizedUpdates` (whose audience is applied in SQL, so
 * nothing is filtered afterwards) and the campaign timezone from
 * `readReportingSchedule`. Nothing here re-derives completion, and nothing
 * here decides an audience.
 *
 * The Captain half deliberately builds its card from `ProjectReportingStatus`
 * alone: reporting is keyed on `hq_projects`, so `projectName` and the weeks
 * are there for a project an admin created in the CRM exactly as they are for
 * an imported team. Roster, image and Colosseum link still need a
 * `BuilderTeam`, and the page adds those where it has one; the reporting half
 * of a card is never reduced.
 */

/** The number of recent updates a member screen shows before the rest go behind a cursor. */
const RECENT_UPDATES = 10;

/**
 * A week as a TEAM may be told about it.
 *
 * Deliberately not `PeriodStatus`. That shape carries `entries` (a count of
 * every qualifying entry in the week, a Captain's sensitive notes included),
 * `latestEntryAt` and `basis` ("entry" or "submission"), and the panel below
 * is handed whole to a client component, so every one of those fields is
 * serialized into the page whether or not anything renders it. The entry list
 * already withholds another author's sensitive note in SQL; a count and a
 * timestamp beside it would hand back exactly what the list withheld, and a
 * team could read off how many hidden notes its Captain wrote and when.
 *
 * What is left is what the screen actually says: which week it is, when it
 * runs, and whether it is done. `completed` stays, because it is the team's
 * own answer: only a team member's update completes a week, so the flag never
 * reveals anything about a Captain's notes.
 */
export type TeamPeriodView = {
  periodId: string;
  periodSequence: number;
  /** Inclusive local dates, what the screen prints. */
  startDate: string;
  endDate: string;
  /** The open/closed comparison the prompt makes. Nothing about who wrote what. */
  startsAt: string;
  endsAt: string;
  completed: boolean;
};

const toTeamPeriod = (period: PeriodStatus): TeamPeriodView => ({
  periodId: period.periodId,
  periodSequence: period.periodSequence,
  startDate: period.startDate,
  endDate: period.endDate,
  startsAt: period.startsAt,
  endsAt: period.endsAt,
  completed: period.completed,
});

export type TeamReportingPanel = {
  projectId: string;
  hackathonId: number;
  /** The campaign timezone, so the Monday and Tuesday prompt is decided in the campaign's days, not the browser's. */
  timezone: string;
  /** False for a team that is not in weekly reporting yet; the screen says so rather than showing an empty week. */
  enrolled: boolean;
  paused: boolean;
  current: TeamPeriodView | null;
  missedPeriods: number;
  history: TeamPeriodView[];
  /** The edition's period count, the N in "Week n of N". A count of weeks and nothing about any of them. */
  totalPeriods: number;
  /** The updates this viewer may read, newest first. Never a sensitive note that is not their own, and never a voided one. */
  entries: ReportingEntryView[];
  /** The next page's cursor, or null at the end. The screen's Load more carries it back through `loadTeamUpdates`. */
  nextCursor: string | null;
  /** The team's preferred contact, which its lead sets and its Captain reads. */
  teamContact: string | null;
  /**
   * The final period, once the edition has one. Present whether or not it is
   * open: the plan keeps the submission detail visible after the period ends
   * ("retain history and submission details"), and the screen decides how
   * prominent it is from `submissionFocus.open`.
   */
  submissionFocus: SubmissionFocusView | null;
};

/**
 * The reporting half of the team page, for a viewer already authorized on the
 * team (the page's `memberTeamView` made that decision). Reads no wider than
 * the viewer: `readAuthorizedUpdates` answers an unauthorized reader with an
 * empty page rather than an error, so a mistake here shows nothing rather
 * than something.
 */
export async function teamReportingPanel(
  actor: MemberActor,
  input: { projectId: string; hackathonId: number; atMs?: number },
  db: BuilderQuery = builderDatabase(),
): Promise<TeamReportingPanel> {
  const atMs = input.atMs ?? Date.now();
  const [schedule, statuses, page, contacts] = await Promise.all([
    readReportingSchedule(db, input.hackathonId),
    reportingStatus(db, { hackathonId: input.hackathonId, projectIds: [input.projectId], atMs, includeHistory: true }),
    readAuthorizedUpdates(actor, { projectId: input.projectId, hackathonId: input.hackathonId, limit: RECENT_UPDATES }, db),
    readTeamContacts(db, [input.projectId]),
  ]);
  const status = statuses[0];
  const timezone = schedule?.timezone ?? "Europe/Amsterdam";
  const focus = status
    ? (await submissionFocusFor({ hackathonId: input.hackathonId, projectIds: [input.projectId], atMs, timezone, statuses }, db)).get(input.projectId) ?? null
    : null;
  return {
    projectId: input.projectId,
    hackathonId: input.hackathonId,
    timezone,
    enrolled: Boolean(status),
    paused: Boolean(status?.paused),
    current: status?.current ? toTeamPeriod(status.current) : null,
    missedPeriods: status?.missedPeriods ?? 0,
    history: (status?.history ?? []).map(toTeamPeriod),
    totalPeriods: status?.history.length ?? 0,
    entries: page.entries,
    nextCursor: page.nextCursor,
    teamContact: contacts.get(input.projectId) ?? null,
    submissionFocus: focus,
  };
}

/**
 * The account's own project state for Home's attention indicators. The
 * team-facing period reveals no entry counts or sensitive-note details.
 */
export type MemberWeekSummary = {
  projectId: string;
  projectName: string;
  hackathonId: number;
  /** The campaign timezone of that project's edition, so the prompt's day is the campaign's. */
  timezone: string;
  enrolled: boolean;
  paused: boolean;
  current: TeamPeriodView | null;
  missedPeriods: number;
  /** The edition's period count, the N in "Week n of N". Deliberately a count and not the weeks themselves. */
  totalPeriods: number;
  /** Only the facts needed to identify a remaining submission action. */
  submission?: {
    periodId: string;
    open: boolean;
    submissionStatus: SubmissionFocusView["submissionStatus"];
    deadline: string;
  } | null;
};

/**
 * The week for each of the account's own projects, in one grouped read per
 * edition rather than one per project: `reportingStatus` already takes a set
 * of project ids, and a person's teams are a handful at most.
 */
export async function memberWeekSummaries(
  projects: readonly { id: string; name: string; hackathonId: number }[],
  db: BuilderQuery = builderDatabase(),
  atMs: number = Date.now(),
): Promise<MemberWeekSummary[]> {
  if (!projects.length) return [];
  const editions = [...new Set(projects.map((project) => project.hackathonId))];
  const reads = await Promise.all(editions.map(async (hackathonId) => {
    const ids = projects.filter((project) => project.hackathonId === hackathonId).map((project) => project.id);
    const [schedule, statuses] = await Promise.all([
      readReportingSchedule(db, hackathonId),
      reportingStatus(db, { hackathonId, projectIds: ids, atMs, includeHistory: true }),
    ]);
    const timezone = schedule?.timezone ?? "Europe/Amsterdam";
    const submissions = await submissionFocusFor({ hackathonId, projectIds: ids, atMs, timezone, statuses }, db);
    return { hackathonId, timezone, statuses, submissions };
  }));
  const byEdition = new Map(reads.map((read) => [read.hackathonId, read]));
  return projects.map((project) => {
    const read = byEdition.get(project.hackathonId);
    const status = read?.statuses.find((row) => row.projectId === project.id);
    const submission = read?.submissions.get(project.id);
    return {
      projectId: project.id,
      projectName: project.name,
      hackathonId: project.hackathonId,
      timezone: read?.timezone ?? "Europe/Amsterdam",
      enrolled: Boolean(status),
      paused: Boolean(status?.paused),
      current: status?.current ? toTeamPeriod(status.current) : null,
      missedPeriods: status?.missedPeriods ?? 0,
      totalPeriods: status?.history.length ?? 0,
      submission: submission ? {
        periodId: submission.period.periodId,
        open: submission.open,
        submissionStatus: submission.submissionStatus,
        deadline: submission.deadline,
      } : null,
    };
  });
}

/**
 * The final period as an authorized member sees it: the submission itself,
 * the deadline it is judged against, the materials and how fresh the reading
 * is.
 *
 * Built from the same three sources every other surface uses and no fourth
 * one: the period from `reportingStatus`, the snapshot from
 * `hq_project_onboarding` (whose `submission_status` only
 * `interpretSubmission` ever writes), and the requirements plus the official
 * deadline from `hq_reporting_config`, which an admin owns.
 *
 * `completedBySubmission` is derived from the project's OWN submission and
 * nothing else. The period's `basis` would answer it directly and is
 * deliberately not carried here, for the same reason `TeamPeriodView` leaves
 * it out: `basis: "entry"` on a week a team can see no entries for would tell
 * them a Captain wrote something they may not read. What a team's own
 * submission status says about their own week gives nothing away.
 */
export type SubmissionFocusView = {
  projectId: string;
  hackathonId: number;
  /** The submission period itself, whether it is open now or has ended. */
  period: TeamPeriodView;
  /** Whether that period is the one open at the instant this was built. */
  open: boolean;
  timezone: string;
  /** The project on Colosseum, which is where a submission is actually made. */
  projectUrl: string;
  submissionStatus: SubmissionStatus;
  submittedAt: string | null;
  /** The instant a submission must beat: the edition's official deadline when one is recorded, else the period's own end. */
  deadline: string;
  /** Whether that deadline is Colosseum's own rather than HQ's window, so the screen can say which. */
  deadlineIsOfficial: boolean;
  /** Whether the recorded submission beat the deadline. Null while nothing has been established. */
  onTime: boolean | null;
  /** True when a confirmed, on-time submission is what satisfies this period for this project. */
  completedBySubmission: boolean;
  items: ChecklistItem[];
  sourceStatus: ProjectSubmissionSnapshot["sourceStatus"];
  sourceCheckedAt: string | null;
  /**
   * The closing reconciliation, once the period has closed. `pending` means
   * HQ could not reach Colosseum at the close and has established nothing;
   * the screen says exactly that rather than implying a failure to submit.
   */
  reconciliation: { state: "pending" | "resolved"; onTime: boolean | null; submissionStatus: SubmissionStatus | null } | null;
};

/** Colosseum's own signal, as phase 3's `interpretSubmission` wrote it. Re-exported nowhere; the surface types name it. */
type SubmissionStatus = ProjectSubmissionSnapshot["submissionStatus"];

/** The final-period view for one project, or null when the edition has no submission period or the project has no Colosseum source. */
function toSubmissionFocus(input: {
  projectId: string;
  hackathonId: number;
  timezone: string;
  atMs: number;
  period: PeriodStatus | undefined;
  snapshot: ProjectSubmissionSnapshot | undefined;
  config: { officialSubmissionDeadline: string | null; requiredMaterials: string[]; optionalMaterials: string[] };
  reconciliation: SubmissionReconciliation | undefined;
}): SubmissionFocusView | null {
  const { period, snapshot } = input;
  if (!period || period.mode !== "submission" || !snapshot) return null;
  const deadline = submissionDeadlineFor(period, input.config.officialSubmissionDeadline);
  const onTime = snapshot.submissionStatus === "submitted"
    ? submittedOnTime(snapshot.submittedAt, deadline, input.config.officialSubmissionDeadline == null)
    : null;
  return {
    projectId: input.projectId,
    hackathonId: input.hackathonId,
    period: toTeamPeriod(period),
    open: isOpenSubmissionPeriod(period, input.atMs),
    timezone: input.timezone,
    projectUrl: snapshot.projectUrl,
    submissionStatus: snapshot.submissionStatus,
    submittedAt: snapshot.submittedAt,
    deadline,
    deadlineIsOfficial: input.config.officialSubmissionDeadline != null,
    onTime,
    completedBySubmission: snapshot.submissionStatus === "submitted" && onTime === true,
    items: submissionChecklist({
      links: snapshot.links,
      requirements: materialRequirements(input.config),
    }),
    sourceStatus: snapshot.sourceStatus,
    sourceCheckedAt: snapshot.sourceCheckedAt,
    reconciliation: input.reconciliation
      ? {
        state: input.reconciliation.state,
        onTime: input.reconciliation.onTime,
        submissionStatus: input.reconciliation.submissionStatus,
      }
      : null,
  };
}

/**
 * The final-period views for a set of projects in one edition, in the same
 * grouped shape the rest of this module uses: one configuration read, one
 * snapshot read and one reconciliation read whatever the project count.
 *
 * The CALLER has already authorized every project id it passes. This is a
 * composition over rows, not a decision, which is what lets the team page,
 * the Captain board and the admin panel share it.
 */
export async function submissionFocusFor(
  input: { hackathonId: number; projectIds: readonly string[]; atMs: number; timezone?: string; statuses?: readonly ProjectReportingStatus[] },
  db: BuilderQuery = builderDatabase(),
): Promise<Map<string, SubmissionFocusView>> {
  const ids = [...new Set(input.projectIds)];
  const views = new Map<string, SubmissionFocusView>();
  if (!ids.length) return views;
  const [statuses, config, snapshots, schedule] = await Promise.all([
    input.statuses ?? reportingStatus(db, { hackathonId: input.hackathonId, projectIds: ids, atMs: input.atMs, includeHistory: true }),
    readReportingConfig(db, input.hackathonId),
    readSubmissionSnapshots(db, ids),
    input.timezone ? Promise.resolve(null) : readReportingSchedule(db, input.hackathonId),
  ]);
  const timezone = input.timezone ?? schedule?.timezone ?? "Europe/Amsterdam";
  const finalPeriod = statuses[0]?.history.find((period) => period.mode === "submission");
  if (!finalPeriod) return views;
  const reconciliations = new Map(
    (await readSubmissionReconciliations(db, { projectIds: ids, periodId: finalPeriod.periodId }))
      .map((row) => [row.projectId, row]),
  );
  for (const status of statuses) {
    const view = toSubmissionFocus({
      projectId: status.projectId,
      hackathonId: input.hackathonId,
      timezone,
      atMs: input.atMs,
      period: status.history.find((period) => period.mode === "submission"),
      snapshot: snapshots.get(status.projectId),
      config,
      reconciliation: reconciliations.get(status.projectId),
    });
    if (view) views.set(status.projectId, view);
  }
  return views;
}

export type CaptainReportingCard = {
  /** The service's own row, for the page's ordering and its project identity. Never handed to a client component whole. */
  status: ProjectReportingStatus;
  /** The open week and every stored week, in the same team-facing shape the team page uses. */
  current: TeamPeriodView | null;
  weeks: TeamPeriodView[];
  /** The team's preferred contact, or null when its lead has not set one. */
  teamContact: string | null;
  /**
   * The updates this Captain may read on this project, newest first: a page,
   * not only the newest one. A card that carried a single entry left every
   * earlier note with no control to open or edit it the moment a teammate
   * posted a newer one, which is the access the plan promises its authors.
   */
  entries: ReportingEntryView[];
  /** The next page's cursor, or null at the end. The card's Load more carries it back through `loadTeamUpdates`. */
  nextCursor: string | null;
  /** The final period for this project, once the edition has one. Same shape the team sees, so the two cannot disagree. */
  submissionFocus: SubmissionFocusView | null;
};

export type CaptainReportingBoard = {
  hackathonId: number;
  timezone: string;
  cards: CaptainReportingCard[];
  /**
   * Where the edition is: the open period's sequence and the edition's
   * period count, or null outside the campaign. Decided once for the board
   * rather than read off a card, so the "Week n of N" line is there for a
   * Captain whose projects are not in reporting yet.
   */
  week: { sequence: number; total: number } | null;
  /** The handle this Captain is reached on, as `readCaptainHandle` resolves it: their Telegram username first. */
  captainContact: string | null;
};

/**
 * Every project this Captain currently holds, with its weeks, the team's
 * contact and the latest update they may read.
 *
 * `reportingStatus` is called once for the whole set, narrowed by
 * `projectIds`, never once per card. The latest update is one small query per
 * board, with a per-project limit and current assignment/audience checks
 * applied before any content is returned.
 */
export async function captainReportingBoard(
  actor: MemberActor,
  hackathonId: number,
  db: BuilderQuery = builderDatabase(),
  atMs: number = Date.now(),
): Promise<CaptainReportingBoard> {
  const [assignments, schedule, captainContact, periods] = await Promise.all([
    listAssignments(db, { hackathonId, captainUserId: actor.id }),
    readReportingSchedule(db, hackathonId),
    readCaptainHandle(db, actor.id),
    listReportingPeriods(db, hackathonId),
  ]);
  const timezone = schedule?.timezone ?? "Europe/Amsterdam";
  const open = periodForInstant(periods, atMs);
  const week = open ? { sequence: open.sequence, total: periods.length } : null;
  if (!assignments.length) return { hackathonId, timezone, cards: [], week, captainContact };

  const projectIds = assignments.map((assignment) => assignment.projectId);
  const [statuses, contacts, pages] = await Promise.all([
    reportingStatus(db, { hackathonId, projectIds, atMs, includeHistory: true }),
    readTeamContacts(db, projectIds),
    readCaptainUpdatePages(actor, { hackathonId, projectIds, limit: RECENT_UPDATES }, db),
  ]);
  const focus = await submissionFocusFor({ hackathonId, projectIds, atMs, timezone, statuses }, db);
  const statusBy = new Map(statuses.map((status) => [status.projectId, status]));

  const cards: CaptainReportingCard[] = [];
  assignments.forEach((assignment) => {
    const status = statusBy.get(assignment.projectId);
    // A project with no eligibility row is not in reporting yet, so it has no
    // weeks to show. The card still appears, built from the assignment's own
    // project name, and says so.
    cards.push({
      status: status ?? {
        projectId: assignment.projectId,
        projectName: assignment.projectName,
        hackathonId,
        imported: false,
        eligibleFrom: "",
        paused: false,
        captainUserId: actor.id,
        submissionStatus: "not_checked",
        current: null,
        missedPeriods: 0,
        history: [],
      },
      current: status?.current ? toTeamPeriod(status.current) : null,
      weeks: (status?.history ?? []).map(toTeamPeriod),
      teamContact: contacts.get(assignment.projectId) ?? null,
      entries: pages.get(assignment.projectId)?.entries ?? [],
      nextCursor: pages.get(assignment.projectId)?.nextCursor ?? null,
      submissionFocus: focus.get(assignment.projectId) ?? null,
    });
  });
  return { hackathonId, timezone, cards, week, captainContact };
}
