import "server-only";
import type { MemberActor } from "./actor";
import { builderDatabase, type BuilderQuery } from "./builder-db";
import { listAssignments } from "./captains";
import { readCaptainContact, readTeamContacts } from "./reporting-contacts";
import {
  readAuthorizedUpdates,
  readReportingSchedule,
  reportingStatus,
  type PeriodStatus,
  type ProjectReportingStatus,
  type ReportingEntryView,
} from "./reporting";

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
 * runs, and whether it is done. `completed` stays, because a sensitive note
 * completing the week is the documented rule the team is told about
 * ("it still completes the week"); how it was completed is not.
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
  /** The updates this viewer may read, newest first. Never a sensitive note that is not their own, and never a voided one. */
  entries: ReportingEntryView[];
  /** The next page's cursor, or null at the end. The screen's Load more carries it back through `loadTeamUpdates`. */
  nextCursor: string | null;
  /** The team's preferred contact, which its lead sets and its Captain reads. */
  teamContact: string | null;
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
  input: { projectId: string; hackathonId: number },
  db: BuilderQuery = builderDatabase(),
): Promise<TeamReportingPanel> {
  const [schedule, statuses, page, contacts] = await Promise.all([
    readReportingSchedule(db, input.hackathonId),
    reportingStatus(db, { hackathonId: input.hackathonId, projectIds: [input.projectId], includeHistory: true }),
    readAuthorizedUpdates(actor, { projectId: input.projectId, hackathonId: input.hackathonId, limit: RECENT_UPDATES }),
    readTeamContacts(db, [input.projectId]),
  ]);
  const status = statuses[0];
  return {
    projectId: input.projectId,
    hackathonId: input.hackathonId,
    timezone: schedule?.timezone ?? "Europe/Amsterdam",
    enrolled: Boolean(status),
    paused: Boolean(status?.paused),
    current: status?.current ? toTeamPeriod(status.current) : null,
    missedPeriods: status?.missedPeriods ?? 0,
    history: (status?.history ?? []).map(toTeamPeriod),
    entries: page.entries,
    nextCursor: page.nextCursor,
    teamContact: contacts.get(input.projectId) ?? null,
  };
}

/**
 * One of the account's own teams as the HQ home page shows it: whose week it
 * is, whether it is done and when it is due.
 *
 * The plan's login experience is "prompt for the weekly update", and until
 * this the prompt lived only on the team detail screen: someone who signed in
 * and stayed on the dashboard saw a verification badge and an Open team
 * button, and nothing at all about the update they owed. The same team-facing
 * week shape as everywhere else, so the home page cannot see more of a
 * Captain's sensitive notes than the team page does.
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
};

/**
 * The week for each of the account's own projects, in one grouped read per
 * edition rather than one per project: `reportingStatus` already takes a set
 * of project ids, and a person's teams are a handful at most.
 */
export async function memberWeekSummaries(
  projects: readonly { id: string; name: string; hackathonId: number }[],
  db: BuilderQuery = builderDatabase(),
): Promise<MemberWeekSummary[]> {
  if (!projects.length) return [];
  const editions = [...new Set(projects.map((project) => project.hackathonId))];
  const reads = await Promise.all(editions.map(async (hackathonId) => {
    const ids = projects.filter((project) => project.hackathonId === hackathonId).map((project) => project.id);
    const [schedule, statuses] = await Promise.all([
      readReportingSchedule(db, hackathonId),
      reportingStatus(db, { hackathonId, projectIds: ids }),
    ]);
    return { hackathonId, timezone: schedule?.timezone ?? "Europe/Amsterdam", statuses };
  }));
  const byEdition = new Map(reads.map((read) => [read.hackathonId, read]));
  return projects.map((project) => {
    const read = byEdition.get(project.hackathonId);
    const status = read?.statuses.find((row) => row.projectId === project.id);
    return {
      projectId: project.id,
      projectName: project.name,
      hackathonId: project.hackathonId,
      timezone: read?.timezone ?? "Europe/Amsterdam",
      enrolled: Boolean(status),
      paused: Boolean(status?.paused),
      current: status?.current ? toTeamPeriod(status.current) : null,
      missedPeriods: status?.missedPeriods ?? 0,
    };
  });
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
};

export type CaptainReportingBoard = {
  hackathonId: number;
  timezone: string;
  cards: CaptainReportingCard[];
  /** The contact this Captain has approved for their assigned teams. */
  captainContact: string | null;
};

/**
 * Every project this Captain currently holds, with its weeks, the team's
 * contact and the latest update they may read.
 *
 * `reportingStatus` is called once for the whole set, narrowed by
 * `projectIds`, never once per card. The latest update is one small query per
 * card, which is the audience decision itself: an entry list is the one read
 * whose result depends on who is asking, and a Captain holds a handful of
 * projects, not a page of them.
 */
export async function captainReportingBoard(
  actor: MemberActor,
  hackathonId: number,
  db: BuilderQuery = builderDatabase(),
): Promise<CaptainReportingBoard> {
  const [assignments, schedule, captainContact] = await Promise.all([
    listAssignments(db, { hackathonId, captainUserId: actor.id }),
    readReportingSchedule(db, hackathonId),
    readCaptainContact(db, actor.id),
  ]);
  const timezone = schedule?.timezone ?? "Europe/Amsterdam";
  if (!assignments.length) return { hackathonId, timezone, cards: [], captainContact };

  const projectIds = assignments.map((assignment) => assignment.projectId);
  const [statuses, contacts] = await Promise.all([
    reportingStatus(db, { hackathonId, projectIds, includeHistory: true }),
    readTeamContacts(db, projectIds),
  ]);
  const statusBy = new Map(statuses.map((status) => [status.projectId, status]));
  const pages = await Promise.all(
    projectIds.map((projectId) => readAuthorizedUpdates(actor, { projectId, hackathonId, limit: RECENT_UPDATES }, db)),
  );

  const cards: CaptainReportingCard[] = [];
  assignments.forEach((assignment, index) => {
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
      entries: pages[index].entries,
      nextCursor: pages[index].nextCursor,
    });
  });
  return { hackathonId, timezone, cards, captainContact };
}
