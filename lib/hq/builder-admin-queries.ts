import "server-only";
import { requireUser } from "./auth";
import { realEmail } from "./builder-store";
import { listActiveCapabilitiesForUsers, listCapabilityGrants } from "./capabilities";
import {
  countAssignmentsForUsers, leaderboard, listAssignments, listCaptainInvitations,
  type CaptainInvitationListing, type CurrentCaptainAssignment,
} from "./captains";
import { getSql } from "./db";
import { requireHackathon } from "./hackathon";
import { operatorQuery } from "./queries";
import type { CaptainLeaderboardView } from "./view-models";

export type OnboardingConfig = {
  externalHackathonId: number | null;
  externalHackathonSlug: string;
  projectsOpen: boolean;
  projectsAvailableAt: string;
  signupUrl: string;
  hostingEnabled: boolean;
};

/** A linked Telegram identity as Admin shows it. `username` is null when Telegram reports none. */
export type TelegramLogin = { username: string | null };

/**
 * How an account signs in, for display. `email` is the verified login
 * address or null; a Telegram-only account has `telegram` instead. The
 * internal placeholder address is never in either field.
 */
export type AccountLogin = { email: string | null; telegram: TelegramLogin | null };

export type BuilderAccount = AccountLogin & {
  id: string;
  name: string;
  /** The optional, self-declared contact email on the profile. Never derived from the login, never a placeholder. */
  contactEmail: string | null;
  tier: "regular" | "member";
  /** Holds an active Captain grant. Read from hq_account_capabilities, never from a role or the tier. */
  captain: boolean;
  /** Current assignments this account would lose if its Captain grant were revoked now, across every edition. 0 when `captain` is false. */
  captainAssignmentCount: number;
};

/** An active Captain grant, for the Admin overview. Grants are account-global, not per hackathon. */
export type ActiveCaptain = {
  userId: string;
  name: string;
  grantedAt: string;
  reason: string | null;
};

export type BuilderHostRequest = AccountLogin & {
  id: string;
  name: string;
  title: string;
  details: string;
  status: "pending" | "approved" | "declined";
};

export type BuilderImportRequest = AccountLogin & {
  id: string;
  name: string;
  projectUrl: string;
  note: string;
  status: "pending" | "resolved";
};

export type BuilderProjectReview = {
  id: string;
  name: string;
  projectUrl: string;
  externalId: number;
  description: string;
  country: string;
  ownerName: string;
  /** How the owner account signs in: the same shape as an account row's `email` and `telegram`. */
  owner: AccountLogin;
  verification: "pending" | "verified" | "rejected";
  stage: string;
  leadUsername: string;
  highPotential: boolean;
  proofCommentId: string | null;
  proofAuthorId: string | null;
  members: Array<{ name: string; username: string; joined: boolean; joinedAt: string | null }>;
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

export async function getBuilderAdminData() {
  await requireUser();
  const hackathon = await requireHackathon();
  const sql = getSql();
  const [configs, accounts, requests, captains, invitations, captainLeaderboard, captainAssignments] = await Promise.all([
    sql`SELECT external_hackathon_id, external_hackathon_slug, projects_open,
        projects_available_at::text, signup_url, hosting_enabled
        FROM hq_hackathon_onboarding WHERE hackathon_id = ${hackathon.id}`,
    sql.query(`SELECT b.id, b.name, b.contact_email, b.tier, ${LOGIN_COLUMNS}
        FROM hq_builder_profiles b ${LOGIN_JOIN}
        WHERE EXISTS (SELECT 1 FROM hq_people p
          WHERE p.builder_user_id = b.id AND p.hackathon_id = $1)
        ORDER BY b.created_at DESC`, [hackathon.id]) as Promise<Record<string, unknown>[]>,
    sql.query(`SELECT r.id, b.name, r.title, r.details, r.status, ${LOGIN_COLUMNS}
        FROM hq_event_host_requests r JOIN hq_builder_profiles b ON b.id = r.user_id ${LOGIN_JOIN}
        WHERE r.hackathon_id = $1
        ORDER BY (r.status = 'pending') DESC, r.created_at DESC`, [hackathon.id]) as Promise<Record<string, unknown>[]>,
    // This is the same active-Captain-grant read leaderboard() below makes
    // again on its own: fetched here for the account list's `captain` flag
    // (BuilderAccount, below) and again inside leaderboard() for the merge
    // that keeps a zero-assignment Captain visible. Left as two calls
    // deliberately rather than threading this list into leaderboard() as a
    // parameter: leaderboard()'s own narrowing of the grant row (dropping
    // `reason`, `grantedByUserId`, `revokedByUserId` before anything else
    // sees it) is what makes it safe to hand the same function straight to
    // a Captain's own page too, and a caller-supplied grant list would
    // reopen exactly that seam for a future caller that forgot to narrow
    // its own copy first.
    listCapabilityGrants({ capability: "captain", activeOnly: true }, operatorQuery()),
    // Invitations are account-global like the grants above, never scoped to
    // this hackathon's People list.
    listCaptainInvitations(operatorQuery()),
    // The same leaderboard the Captain's own dashboard reads, gated here by
    // this function's own requireUser() above rather than a second flag or
    // function — see lib/hq/captains.ts#leaderboard. No viewer to mark "you".
    leaderboard(operatorQuery(), hackathon.id, null),
    // The admin-only drilldown: every current assignment in the edition,
    // with the captain id and name listAssignments() carries and the
    // member-facing leaderboard never does. A separate call from the
    // Captain's own (which passes captainUserId), not a flag on this one.
    listAssignments(operatorQuery(), { hackathonId: hackathon.id }),
  ]);
  const capabilities = await listActiveCapabilitiesForUsers(accounts.map((row) => String(row.id)), operatorQuery());
  // Confirm the affected project count to the admin before they revoke: this
  // batches it in the same one-query-per-render shape as `capabilities`
  // above, rather than one query per account.
  const assignmentCounts = await countAssignmentsForUsers(operatorQuery(), accounts.map((row) => String(row.id)));
  const config = configs[0];
  return {
    hackathonName: hackathon.name,
    config: {
      externalHackathonId: config?.external_hackathon_id == null ? null : Number(config.external_hackathon_id),
      externalHackathonSlug: String(config?.external_hackathon_slug ?? ""),
      projectsOpen: Boolean(config?.projects_open),
      projectsAvailableAt: String(config?.projects_available_at ?? ""),
      signupUrl: String(config?.signup_url ?? "https://colosseum.com/signup"),
      hostingEnabled: Boolean(config?.hosting_enabled),
    } satisfies OnboardingConfig,
    accounts: accounts.map((row) => ({
      id: String(row.id), name: String(row.name), ...login(row), contactEmail: realEmail(row.contact_email),
      tier: row.tier === "member" ? "member" : "regular",
      captain: (capabilities.get(String(row.id)) ?? []).includes("captain"),
      captainAssignmentCount: assignmentCounts.get(String(row.id)) ?? 0,
    } satisfies BuilderAccount)),
    captains: captains.map((grant) => ({
      userId: grant.userId, name: grant.userName, grantedAt: grant.grantedAt, reason: grant.reason,
    } satisfies ActiveCaptain)),
    hostRequests: requests.map((row) => ({
      id: String(row.id), name: String(row.name), ...login(row),
      title: String(row.title), details: String(row.details), status: row.status as BuilderHostRequest["status"],
    } satisfies BuilderHostRequest)),
    captainInvitations: invitations satisfies CaptainInvitationListing[],
    captainLeaderboard: captainLeaderboard satisfies CaptainLeaderboardView[],
    captainAssignments: captainAssignments satisfies CurrentCaptainAssignment[],
  };
}

export async function getBuilderProjectReviews() {
  await requireUser();
  const hackathon = await requireHackathon();
  const sql = getSql();
  const [projects, requests] = await Promise.all([
    sql.query(`SELECT p.id, p.name, o.project_url, o.external_id, o.description, o.country,
        b.name AS owner_name, o.verification, o.stage, ${LOGIN_COLUMNS},
        o.lead_username, o.high_potential, o.proof_comment_id::text, o.proof_author_id::text,
        COALESCE((SELECT json_agg(json_build_object(
          'name', m.name, 'username', COALESCE(m.colosseum_username, ''),
          'joined', m.builder_user_id IS NOT NULL, 'joinedAt', m.joined_at::text
        ) ORDER BY m.sort, m.id) FROM hq_project_members m WHERE m.project_id = p.id), '[]') AS members
        FROM hq_project_onboarding o
        JOIN hq_projects p ON p.id = o.project_id AND p.hackathon_id = o.hackathon_id
        JOIN hq_builder_profiles b ON b.id = o.owner_user_id ${LOGIN_JOIN}
        WHERE o.hackathon_id = $1
        ORDER BY (o.verification = 'pending') DESC, o.high_potential DESC, o.created_at DESC`, [hackathon.id]) as Promise<Record<string, unknown>[]>,
    sql.query(`SELECT r.id, b.name, r.project_url, r.note, r.status, ${LOGIN_COLUMNS}
        FROM hq_project_import_requests r JOIN hq_builder_profiles b ON b.id = r.user_id ${LOGIN_JOIN}
        WHERE r.hackathon_id = $1
        ORDER BY (r.status = 'pending') DESC, r.created_at DESC`, [hackathon.id]) as Promise<Record<string, unknown>[]>,
  ]);
  return {
    projects: projects.map((row) => ({
      id: String(row.id), name: String(row.name), projectUrl: String(row.project_url),
      externalId: Number(row.external_id), description: String(row.description ?? ""),
      country: String(row.country ?? ""), ownerName: String(row.owner_name), owner: login(row),
      verification: row.verification as BuilderProjectReview["verification"], stage: String(row.stage), leadUsername: String(row.lead_username ?? ""),
      highPotential: Boolean(row.high_potential), proofCommentId: optionalText(row.proof_comment_id),
      proofAuthorId: optionalText(row.proof_author_id), members: row.members as BuilderProjectReview["members"],
    } satisfies BuilderProjectReview)),
    importRequests: requests.map((row) => ({
      id: String(row.id), name: String(row.name), ...login(row),
      projectUrl: String(row.project_url), note: String(row.note), status: row.status as BuilderImportRequest["status"],
    } satisfies BuilderImportRequest)),
  };
}
