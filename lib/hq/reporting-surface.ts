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

export type TeamReportingPanel = {
  projectId: string;
  hackathonId: number;
  /** The campaign timezone, so the Monday and Tuesday prompt is decided in the campaign's days, not the browser's. */
  timezone: string;
  /** False for a team that is not in weekly reporting yet; the screen says so rather than showing an empty week. */
  enrolled: boolean;
  paused: boolean;
  current: PeriodStatus | null;
  missedPeriods: number;
  history: PeriodStatus[];
  /** The updates this viewer may read, newest first. Never a sensitive note that is not their own, and never a voided one. */
  entries: ReportingEntryView[];
  hasMore: boolean;
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
    current: status?.current ?? null,
    missedPeriods: status?.missedPeriods ?? 0,
    history: status?.history ?? [],
    entries: page.entries,
    hasMore: page.nextCursor !== null,
    teamContact: contacts.get(input.projectId) ?? null,
  };
}

export type CaptainReportingCard = {
  status: ProjectReportingStatus;
  /** The team's preferred contact, or null when its lead has not set one. */
  teamContact: string | null;
  /** The newest update this Captain may read, for the card's summary. Null when there is none they may see. */
  latest: ReportingEntryView | null;
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
    reportingStatus(db, { hackathonId, projectIds }),
    readTeamContacts(db, projectIds),
  ]);
  const statusBy = new Map(statuses.map((status) => [status.projectId, status]));
  const latest = await Promise.all(
    projectIds.map((projectId) => readAuthorizedUpdates(actor, { projectId, hackathonId, limit: 1 }, db)),
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
      teamContact: contacts.get(assignment.projectId) ?? null,
      latest: latest[index].entries[0] ?? null,
    });
  });
  return { hackathonId, timezone, cards, captainContact };
}
