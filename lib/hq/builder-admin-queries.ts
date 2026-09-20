import "server-only";
import { requireUser } from "./auth";
import { realEmail } from "./builder-store";
import { listCapabilityGrants, type CapabilityGrant } from "./capabilities";
import {
  countAssignmentsByCaptain, listAssignments, listCaptainInvitations,
  type CaptainAssignmentCount, type CaptainInvitationListing, type CurrentCaptainAssignment,
} from "./captains";
import { getSql } from "./db";
import { todayInTz } from "./format";
import { requireHackathon } from "./hackathon";
import { listReminderDeliveries, type ReminderDeliveryView } from "./jobs";
import { operatorQuery } from "./queries";
import { readCaptainContacts } from "./reporting-contacts";
import {
  previewReportingPeriods,
  readReportingConfig,
  readReportingSchedule,
  reportingStatus,
  type ProjectReportingStatus,
  type ReportingConfig,
  type ReportingPeriodPlan,
  type ReportingSchedule,
} from "./reporting";
import { isTelegramBotConfigured } from "./telegram-bot-api";

export type OnboardingConfig = {
  externalHackathonId: number | null;
  externalHackathonSlug: string;
  projectsOpen: boolean;
  projectsAvailableAt: string;
  signupUrl: string;
};

/** A linked Telegram identity as Admin shows it. `username` is null when Telegram reports none. */
type TelegramLogin = { username: string | null };

/**
 * How an account signs in, for display. `email` is the verified login
 * address or null; a Telegram-only account has `telegram` instead. The
 * internal placeholder address is never in either field.
 */
export type AccountLogin = { email: string | null; telegram: TelegramLogin | null };

/**
 * One Captain leaderboard row as Admin shows it: the rank, name and
 * active-project count a Captain sees on their own copy (the same ordering
 * as lib/hq/captains.ts#leaderboard), plus the two things only an operator
 * may see: the account id, and the names of every project the Captain
 * currently holds in the edition, active or not. Built from the raw reads
 * rather than by joining leaderboard() to listAssignments() on the display
 * name, which two Captains may share.
 */
export type AdminCaptainLeaderboardRow = {
  rank: number;
  captainUserId: string;
  displayName: string;
  /** Projects whose status counts as active, the number the leaderboard ranks on. */
  assignedCount: number;
  /** Every current assignment in the edition, so this can name a project the count does not include. */
  projectNames: string[];
};

export type BuilderImportRequest = AccountLogin & {
  id: string;
  name: string;
  projectUrl: string;
  note: string;
  status: "pending" | "resolved";
  /** The HQ project an admin created for this request, or null while there is none. */
  projectId: string | null;
  projectName: string | null;
};

/** A nullable text column as the type says: null stays null. */
const optionalText = (value: unknown) => (value == null ? null : String(value));

/**
 * The login columns every account-bearing row selects: the profile email
 * through `realEmail`, so the placeholder can never reach a page even from
 * a row that somehow holds it, and the Telegram identity when linked.
 */
const LOGIN_COLUMNS = `b.email, t.user_id IS NOT NULL AS has_telegram, t.username AS telegram_username`;
const LOGIN_JOIN = `LEFT JOIN hq_auth_telegram_identity t ON t.user_id = b.id`;
const login = (row: Record<string, unknown>): AccountLogin => ({
  email: realEmail(row.email),
  telegram: row.has_telegram ? { username: optionalText(row.telegram_username) } : null,
});

/** The admin leaderboard rows: count descending, then name, exactly as leaderboard() orders a Captain's own copy. */
function adminLeaderboard(grants: CapabilityGrant[], counts: CaptainAssignmentCount[], assignments: CurrentCaptainAssignment[]): AdminCaptainLeaderboardRow[] {
  const countByUser = new Map(counts.map((row) => [row.captainUserId, row.assignedCount]));
  const namesByUser = new Map<string, string[]>();
  for (const row of assignments) namesByUser.set(row.captainUserId, [...(namesByUser.get(row.captainUserId) ?? []), row.projectName]);
  return grants
    .map((grant) => ({
      captainUserId: grant.userId, displayName: grant.userName,
      assignedCount: countByUser.get(grant.userId) ?? 0, projectNames: namesByUser.get(grant.userId) ?? [],
    }))
    .sort((a, b) => b.assignedCount - a.assignedCount || a.displayName.localeCompare(b.displayName))
    .map((row, index) => ({ rank: index + 1, ...row }));
}

export async function getBuilderAdminData() {
  await requireUser();
  const hackathon = await requireHackathon();
  const sql = getSql();
  const db = operatorQuery();
  const [configs, grants, counts, assignments, invitations] = await Promise.all([
    sql`SELECT external_hackathon_id, external_hackathon_slug, projects_open,
        projects_available_at::text, signup_url
        FROM hq_hackathon_onboarding WHERE hackathon_id = ${hackathon.id}`,
    // Grants are account-global: a Captain with no assignment in this
    // edition still has a row, at zero, which is what makes an account
    // eligible for the leaderboard at all.
    listCapabilityGrants({ capability: "captain", activeOnly: true }, db),
    countAssignmentsByCaptain(db, hackathon.id),
    // The admin-only read, with the captain id listAssignments() carries and
    // the member-facing leaderboard never does.
    listAssignments(db, { hackathonId: hackathon.id }),
    // Invitations are account-global like the grants above, never scoped to
    // this hackathon's People list.
    listCaptainInvitations(db),
  ]);
  const config = configs[0];
  return {
    config: {
      externalHackathonId: config?.external_hackathon_id == null ? null : Number(config.external_hackathon_id),
      externalHackathonSlug: String(config?.external_hackathon_slug ?? ""),
      projectsOpen: Boolean(config?.projects_open),
      projectsAvailableAt: String(config?.projects_available_at ?? ""),
      signupUrl: String(config?.signup_url ?? "https://colosseum.com/signup"),
    } satisfies OnboardingConfig,
    captainInvitations: invitations satisfies CaptainInvitationListing[],
    captainLeaderboard: adminLeaderboard(grants, counts, assignments),
  };
}

/**
 * The edition's project import requests, pending first: the help requests
 * builders sent when Colosseum could not return their project, with the HQ
 * project an admin has since created for each, when there is one.
 */
export async function getImportRequests(): Promise<BuilderImportRequest[]> {
  await requireUser();
  const hackathon = await requireHackathon();
  const sql = getSql();
  const requests = await sql.query(`SELECT r.id, b.name, r.project_url, r.note, r.status, r.project_id::text AS project_id,
        (SELECT p.name FROM hq_projects p WHERE p.id = r.project_id) AS project_name, ${LOGIN_COLUMNS}
      FROM hq_project_import_requests r JOIN hq_builder_profiles b ON b.id = r.user_id ${LOGIN_JOIN}
      WHERE r.hackathon_id = $1
      ORDER BY (r.status = 'pending') DESC, r.created_at DESC`, [hackathon.id]) as Record<string, unknown>[];
  return requests.map((row) => ({
    id: String(row.id), name: String(row.name), ...login(row),
    projectUrl: String(row.project_url), note: String(row.note), status: row.status as BuilderImportRequest["status"],
    projectId: row.project_id == null ? null : String(row.project_id),
    projectName: row.project_name == null ? null : String(row.project_name),
  } satisfies BuilderImportRequest));
}

/* ── Weekly reporting, phase 6 ─────────────────────────────────────── */

/**
 * The edition's reporting schedule as Admin shows it, with the preview of
 * what applying the current dates would do.
 *
 * `previewReportingPeriods` writes nothing: it is the plan's "show affected
 * periods before an admin changes a live schedule", and the conflicts it
 * returns are the weeks a date edit must not move because people have
 * already reported against them or because they are closed.
 */
export type ReportingAdminData = {
  hackathonId: number;
  hackathonName: string;
  /** Null only for an edition that no longer exists. The window and timezone come from the edition's own record. */
  schedule: ReportingSchedule | null;
  config: ReportingConfig;
  plan: ReportingPeriodPlan;
  /** How many projects are in weekly reporting, and how many of those are paused. */
  enrolled: number;
  paused: number;
  /**
   * What happened to each Wednesday reminder in this edition, newest first
   * (phase 8). The plan's "expose the delivery state to admins for
   * inspection" and "record a skipped delivery reason and show it in HQ":
   * names, weeks, counts and outcomes, and no update text of any kind.
   */
  reminders: ReminderDeliveryView[];
  /**
   * Whether this deployment has a Telegram bot configured at all. False means
   * reminders are still decided and recorded, and nothing is delivered, which
   * is a different sentence from "nobody was reachable".
   */
  botConfigured: boolean;
  /**
   * Today's local date in the campaign timezone, read once here so the
   * Open, Closed and Upcoming pills are decided on the server and the client
   * renders exactly what it was sent.
   */
  today: string;
};

/** How many reminders the admin panel shows before the rest stay in the table. */
const REMINDER_PAGE = 30;

export async function getReportingAdminData(): Promise<ReportingAdminData> {
  await requireUser();
  const hackathon = await requireHackathon();
  const db = operatorQuery();
  const [schedule, config, plan, statuses, reminders] = await Promise.all([
    readReportingSchedule(db, hackathon.id),
    readReportingConfig(db, hackathon.id),
    previewReportingPeriods(db, hackathon.id),
    reportingStatus(db, { hackathonId: hackathon.id }),
    listReminderDeliveries(db, { hackathonId: hackathon.id, limit: REMINDER_PAGE }),
  ]);
  return {
    hackathonId: hackathon.id,
    hackathonName: hackathon.name,
    schedule,
    config,
    plan,
    enrolled: statuses.length,
    paused: statuses.filter((status) => status.paused).length,
    reminders,
    botConfigured: isTelegramBotConfigured(),
    today: todayInTz(schedule?.timezone ?? "Europe/Amsterdam"),
  };
}

/** How reachable a Captain is, for the Projects board's own Captain line. */
type CaptainReach = {
  contact: string | null;
  telegram: boolean;
  /** Telegram connected AND messaging agreed to. The bot cannot message an account that only did the first. */
  botMessaging: boolean;
};

type ProjectReportingBoard = {
  /** One row per project in weekly reporting, keyed by project id in the map below. */
  statuses: ProjectReportingStatus[];
  /** Reach details for the Captains currently assigned in this edition, keyed by account id. */
  captains: Record<string, CaptainReach>;
};

/**
 * The reporting half of the Projects board: every project's weekly state in
 * the edition, in `reportingStatus`'s fixed number of queries whatever the
 * project count, plus the contact and delivery availability of the Captains
 * those projects are assigned to.
 *
 * `ProjectReportingStatus` carries `projectName` and `imported` itself, so a
 * project with no imported team behind it is a complete row here. The board
 * joins these to its own rows by project id and leaves a project with no
 * reporting row showing as not in reporting, which is a real state rather
 * than a missing one.
 */
export async function getProjectReportingBoard(): Promise<ProjectReportingBoard> {
  await requireUser();
  const hackathon = await requireHackathon();
  const db = operatorQuery();
  const statuses = await reportingStatus(db, { hackathonId: hackathon.id });
  const captainIds = [...new Set(statuses.map((status) => status.captainUserId).filter((id): id is string => id !== null))];
  if (!captainIds.length) return { statuses, captains: {} };
  const sql = getSql();
  const [contacts, reach] = await Promise.all([
    readCaptainContacts(db, captainIds),
    sql.query(
      `SELECT b.id, t.user_id IS NOT NULL AS has_telegram, COALESCE(bc.messaging_enabled, false) AS bot_messaging
       FROM hq_builder_profiles b
       LEFT JOIN hq_auth_telegram_identity t ON t.user_id = b.id
       LEFT JOIN hq_telegram_bot_consent bc ON bc.user_id = b.id
       WHERE b.id = ANY($1::text[])`,
      [captainIds],
    ) as Promise<Record<string, unknown>[]>,
  ]);
  const captains: Record<string, CaptainReach> = {};
  for (const row of reach) {
    captains[String(row.id)] = {
      contact: contacts.get(String(row.id)) ?? null,
      telegram: Boolean(row.has_telegram),
      botMessaging: Boolean(row.bot_messaging),
    };
  }
  return { statuses, captains };
}
