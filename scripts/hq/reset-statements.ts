// The reset manifest, kept separate from the CLI so it can be tested against
// a throwaway Postgres without executing anything. scripts/hq/reset.ts is the
// only thing that runs it.
//
// The split is "who typed it": configuration comes from scripts/hq/seed.ts and
// survives, operational data was entered through the dashboard and does not.
// Logins survive too, so a reset never locks anyone out or forces a round of
// new passwords.

/** Emptied — everything entered through the dashboard. */
export const CLEAR_TABLES = [
  // Children first: several of these would be taken out by a cascade anyway,
  // but naming them makes the manifest self-documenting and order-independent.
  "hq_scores",
  "hq_finalists",
  "hq_project_gates",
  "hq_project_notes",
  "hq_partner_exchange",
  "hq_partner_contacts",
  "hq_projects",
  "hq_partners",
  "hq_people",
  "hq_events",
  "hq_activity",
] as const;

/** Untouched — logins, sessions, classifiers, settings and seeded campaign setup. */
export const KEEP_TABLES = [
  "hq_users",
  "hq_sessions",
  "hq_login_attempts",
  "hq_login_limits",
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
