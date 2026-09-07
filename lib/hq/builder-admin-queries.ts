import "server-only";
import { requireUser } from "./auth";
import { getSql } from "./db";
import { requireHackathon } from "./hackathon";

export type OnboardingConfig = {
  externalHackathonId: number | null;
  externalHackathonSlug: string;
  projectsOpen: boolean;
  projectsAvailableAt: string;
  signupUrl: string;
  hostingEnabled: boolean;
};

export type BuilderAccount = {
  id: string;
  name: string;
  email: string;
  tier: "regular" | "member";
};

export type BuilderHostRequest = {
  id: string;
  name: string;
  email: string;
  title: string;
  details: string;
  status: "pending" | "approved" | "declined";
};

export type BuilderImportRequest = {
  id: string;
  name: string;
  email: string;
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
  ownerEmail: string;
  verification: "pending" | "verified" | "rejected";
  stage: string;
  leadUsername: string;
  highPotential: boolean;
  proofCommentId: string | null;
  proofAuthorId: string | null;
  members: Array<{ name: string; username: string; joined: boolean; joinedAt: string | null }>;
};

export async function getBuilderAdminData() {
  await requireUser();
  const hackathon = await requireHackathon();
  const sql = getSql();
  const [configs, accounts, requests] = await Promise.all([
    sql`SELECT external_hackathon_id, external_hackathon_slug, projects_open,
        projects_available_at::text, signup_url, hosting_enabled
        FROM hq_hackathon_onboarding WHERE hackathon_id = ${hackathon.id}`,
    sql`SELECT b.id, b.name, b.email, b.tier FROM hq_builder_profiles b
        WHERE EXISTS (SELECT 1 FROM hq_people p
          WHERE p.builder_user_id = b.id AND p.hackathon_id = ${hackathon.id})
        ORDER BY b.created_at DESC`,
    sql`SELECT r.id, b.name, b.email, r.title, r.details, r.status
        FROM hq_event_host_requests r JOIN hq_builder_profiles b ON b.id = r.user_id
        WHERE r.hackathon_id = ${hackathon.id}
        ORDER BY (r.status = 'pending') DESC, r.created_at DESC`,
  ]);
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
      id: String(row.id), name: String(row.name), email: String(row.email),
      tier: row.tier === "member" ? "member" : "regular",
    } satisfies BuilderAccount)),
    hostRequests: requests.map((row) => ({
      id: String(row.id), name: String(row.name), email: String(row.email),
      title: String(row.title), details: String(row.details), status: row.status,
    } satisfies BuilderHostRequest)),
  };
}

export async function getBuilderProjectReviews() {
  await requireUser();
  const hackathon = await requireHackathon();
  const sql = getSql();
  const [projects, requests] = await Promise.all([
    sql`SELECT p.id, p.name, o.project_url, o.external_id, o.description, o.country,
        b.name AS owner_name, b.email AS owner_email, o.verification, o.stage,
        o.lead_username, o.high_potential, o.proof_comment_id::text, o.proof_author_id::text,
        COALESCE((SELECT json_agg(json_build_object(
          'name', m.name, 'username', COALESCE(m.colosseum_username, ''),
          'joined', m.builder_user_id IS NOT NULL, 'joinedAt', m.joined_at::text
        ) ORDER BY m.sort, m.id) FROM hq_project_members m WHERE m.project_id = p.id), '[]') AS members
        FROM hq_project_onboarding o
        JOIN hq_projects p ON p.id = o.project_id AND p.hackathon_id = o.hackathon_id
        JOIN hq_builder_profiles b ON b.id = o.owner_user_id
        WHERE o.hackathon_id = ${hackathon.id}
        ORDER BY (o.verification = 'pending') DESC, o.high_potential DESC, o.created_at DESC`,
    sql`SELECT r.id, b.name, b.email, r.project_url, r.note, r.status
        FROM hq_project_import_requests r JOIN hq_builder_profiles b ON b.id = r.user_id
        WHERE r.hackathon_id = ${hackathon.id}
        ORDER BY (r.status = 'pending') DESC, r.created_at DESC`,
  ]);
  return {
    projects: projects.map((row) => ({
      id: String(row.id), name: String(row.name), projectUrl: String(row.project_url),
      externalId: Number(row.external_id), description: String(row.description ?? ""),
      country: String(row.country ?? ""), ownerName: String(row.owner_name), ownerEmail: String(row.owner_email),
      verification: row.verification, stage: String(row.stage), leadUsername: String(row.lead_username ?? ""),
      highPotential: Boolean(row.high_potential), proofCommentId: row.proof_comment_id ?? null,
      proofAuthorId: row.proof_author_id ?? null, members: row.members,
    } satisfies BuilderProjectReview)),
    importRequests: requests.map((row) => ({
      id: String(row.id), name: String(row.name), email: String(row.email),
      projectUrl: String(row.project_url), note: String(row.note), status: row.status,
    } satisfies BuilderImportRequest)),
  };
}
