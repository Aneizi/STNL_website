import "server-only";
import type { BuilderQuery } from "./builder-db";
import { getTelegramIdentity } from "./identity";
import { normalizeContact } from "./reporting-view";

/**
 * The two opt-in contacts the reporting dashboards show, read and written
 * through the query handle they are given.
 *
 * A team's preferred contact (`hq_project_onboarding.team_contact`) is set by
 * the team lead and read by that team's assigned Captain and by admins. A
 * Captain's approved contact (`hq_builder_profiles.captain_contact`) is set
 * by the Captain and read by the teams they are currently assigned to, and by
 * admins. Both are free text on purpose: the plan asks for a preferred
 * contact "including a Telegram contact when available", and a person who
 * wants to be reached on Telegram, on email or somewhere else entirely should
 * not have to pick from a list HQ invented.
 *
 * Nothing here decides who may read a contact. The surfaces do, over the
 * decision they already made: a team page shows its own Captain's contact
 * because the viewer is authorized on that team, and a Captain sees a team's
 * contact because they hold the current assignment. This module has no
 * `./authz` import for exactly that reason, so operator queries and operator
 * Server Actions can reach it too.
 *
 * Storage is trimmed text or NULL; an empty string is never stored, so
 * "cleared" and "never set" are the same state and read back as null.
 */

// The length limit and the trim rule live in ./reporting-view, which is
// client-safe, because the field that enforces them is a client component and
// this module is server only. Re-exported unchanged so a caller on the server
// still finds them beside the queries that use them.
export { MAX_CONTACT_LENGTH, normalizeContact } from "./reporting-view";

const text = (value: unknown): string | null => {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
};

/** The team's preferred contact, or null when the lead has not set one. Null for a project that was never imported. */
export async function readTeamContact(db: BuilderQuery, projectId: string): Promise<string | null> {
  const { rows } = await db.query("SELECT team_contact FROM hq_project_onboarding WHERE project_id = $1::uuid", [projectId]);
  return rows.length ? text(rows[0].team_contact) : null;
}

/** The same for several projects at once, so a Captain or admin board reads them in one query rather than one per card. */
export async function readTeamContacts(db: BuilderQuery, projectIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(projectIds)];
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    "SELECT project_id::text AS project_id, team_contact FROM hq_project_onboarding WHERE project_id = ANY($1::uuid[]) AND team_contact IS NOT NULL",
    [ids],
  );
  const map = new Map<string, string>();
  for (const row of rows) {
    const value = text(row.team_contact);
    if (value) map.set(String(row.project_id), value);
  }
  return map;
}

/**
 * Sets or clears a team's preferred contact. Returns false when the project
 * has no imported team behind it, which is the only project shape without a
 * row to write to; the caller answers that the way it answers a missing team.
 */
export async function writeTeamContact(db: BuilderQuery, projectId: string, contact: string | null): Promise<boolean> {
  const { rows } = await db.query(
    "UPDATE hq_project_onboarding SET team_contact = $2 WHERE project_id = $1::uuid RETURNING project_id",
    [projectId, normalizeContact(contact)],
  );
  return rows.length > 0;
}

/** The contact this account has approved for the teams it captains, or null. */
export async function readCaptainContact(db: BuilderQuery, userId: string): Promise<string | null> {
  const { rows } = await db.query("SELECT captain_contact FROM hq_builder_profiles WHERE id = $1", [userId]);
  return rows.length ? text(rows[0].captain_contact) : null;
}

/** The same for several accounts, for the admin lists. */
export async function readCaptainContacts(db: BuilderQuery, userIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    "SELECT id, captain_contact FROM hq_builder_profiles WHERE id = ANY($1::text[]) AND captain_contact IS NOT NULL",
    [ids],
  );
  const map = new Map<string, string>();
  for (const row of rows) {
    const value = text(row.captain_contact);
    if (value) map.set(String(row.id), value);
  }
  return map;
}

/**
 * The handle a Captain is reached on, as their teams and their own Captains'
 * Den show it: the username of their linked Telegram identity, rendered
 * "@username", since the redesigned Den shows it read-only and the Account
 * page has no contact field of its own. A Captain without a Telegram
 * username falls back to the contact they typed on the old form, when they
 * set one, and otherwise has nothing to show.
 */
export async function readCaptainHandle(db: BuilderQuery, userId: string): Promise<string | null> {
  const telegram = await getTelegramIdentity(userId, db);
  if (telegram?.username) return `@${telegram.username}`;
  return readCaptainContact(db, userId);
}
