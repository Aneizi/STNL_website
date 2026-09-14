// The reset manifest, kept separate from the CLI so it can be tested against
// a throwaway Postgres without executing anything. scripts/hq/reset.ts is the
// only thing that runs it.
//
// The split is "who typed it": configuration comes from scripts/hq/seed.ts and
// survives, operational data was entered through the dashboard and does not.
// Logins survive too, so a reset never locks anyone out or forces a round of
// new passwords. The hackathons themselves survive as well, with their
// settings, gates, milestones and awards: the reset empties every edition's
// CRM, it does not remove the editions.

/** Emptied — everything entered through the dashboard. */
export const CLEAR_TABLES = [
  // Children first: several of these would be taken out by a cascade anyway,
  // but naming them makes the manifest self-documenting and order-independent.
  "hq_scores",
  "hq_finalists",
  "hq_project_gates",
  "hq_project_notes",
  // Captain assignment history belongs to the project rows below, the same
  // way People and notes do: it names who ran a project in an edition, not a
  // standing grant. The cascade from hq_projects already emptied it before
  // it was named here (task T4.1).
  "hq_captain_assignments",
  // Imported Colosseum teams and their invite codes belong to the project
  // rows below; the cascade from hq_projects already emptied them before they
  // were named here.
  "hq_team_invites",
  "hq_project_onboarding",
  "hq_project_members",
  "hq_partner_exchange",
  "hq_partner_contacts",
  "hq_link_notes",
  "hq_projects",
  "hq_partners",
  "hq_people",
  "hq_events",
  "hq_links",
  "hq_activity",
] as const;

/** Untouched — logins, sessions, hackathons, classifiers, settings and seeded campaign setup. */
export const KEEP_TABLES = [
  "hq_hackathons",
  "hq_users",
  "hq_sessions",
  "hq_login_attempts",
  "hq_login_limits",
  // Public account logins (Better Auth) survive for the same reason operator
  // logins do: a reset empties the campaign, it never signs anyone out.
  "hq_auth_user",
  "hq_auth_session",
  "hq_auth_account",
  "hq_auth_verification",
  "hq_auth_rate_limit",
  "hq_auth_telegram_identity",
  // The public account itself and its stable CRM person: the person is the
  // identity that People cards in every edition point at, so it outlives the
  // cards the way an operator login outlives the campaign.
  "hq_builder_profiles",
  "hq_crm_persons",
  // Admin-granted account capabilities (Captain) and the append-only audit
  // trail behind them, identity links and assignment changes. Both are
  // account-level history, not an edition's CRM, so a reset keeps them the
  // way it keeps logins and persons (ruling Q10, task T1.2).
  "hq_account_capabilities",
  "hq_audit_events",
  // Captain invitations and who redeemed them: account-level grant history
  // like hq_account_capabilities above, not an edition's CRM, so a reset
  // keeps them the same way it keeps the grant itself (task T4.1).
  "hq_captain_invitations",
  "hq_captain_invitation_redemptions",
  // Whether the account agreed to bot messages: a standing decision by the
  // person, not an edition's CRM, so it survives like a login (task T2.3).
  "hq_telegram_bot_consent",
  // Per-edition Colosseum mapping and toggles, typed into Admin: settings,
  // like hq_settings.
  "hq_hackathon_onboarding",
  // Builder-side records the reset never touched before they were classified
  // (task T1.1). Kept so that classifying them changes nothing a live reset
  // does; whether enrollments, challenges and requests should be emptied with
  // the edition's CRM is an open product ruling.
  "hq_builder_enrollments",
  "hq_project_challenges",
  "hq_project_import_requests",
  "hq_event_host_requests",
  "hq_partner_channels",
  "hq_event_types",
  "hq_people_roles",
  "hq_partner_stages",
  "hq_project_statuses",
  "hq_project_forecasts",
  "hq_submission_gates",
  "hq_exchange_items",
  "hq_settings",
  "hq_awards",
  "hq_milestones",
] as const;

/**
 * Applied in order. Children are deleted before parents, so stopping partway
 * leaves the database consistent and re-running finishes the job.
 */
export const RESET_STATEMENTS: string[] = [
  // Awards are kept as campaign setup, but their winners pointed at finalists
  // that are about to disappear. The foreign key would clear these on delete;
  // doing it explicitly keeps the intent visible.
  `UPDATE hq_awards SET winner_project_id = NULL`,

  ...CLEAR_TABLES.map((table) => `DELETE FROM ${table}`),

  // Rewind the Luma throttle so the next load of /hq/events re-mirrors the
  // calendar immediately instead of waiting out the five-minute window.
  `UPDATE hq_luma_sync SET last_success_at = 'epoch'`,
];
