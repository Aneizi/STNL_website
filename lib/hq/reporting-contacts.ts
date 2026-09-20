import "server-only";
import type { BuilderQuery } from "./builder-db";
import { getTelegramIdentity } from "./identity";
import { normalizeContact } from "./reporting-view";

/**
 * Team leads set team contacts; Captains and operators may read them.
 * Captain contacts are visible to assigned teams and operators. Callers must
 * authorize access before using these queries. Store trimmed free text or NULL;
 * cleared and never-set contacts both read as null.
 */

// Share the client-safe validation rules with server callers.
export { MAX_CONTACT_LENGTH, normalizeContact } from "./reporting-view";

const text = (value: unknown): string | null => {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
};

/**
 * Read team contacts in one batch; omit projects without a contact.
 */
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
 * Set or clear the imported team's contact. Return false without an onboarding
 * row; the caller treats this as a missing team.
 */
export async function writeTeamContact(db: BuilderQuery, projectId: string, contact: string | null): Promise<boolean> {
  const { rows } = await db.query(
    "UPDATE hq_project_onboarding SET team_contact = $2 WHERE project_id = $1::uuid RETURNING project_id",
    [projectId, normalizeContact(contact)],
  );
  return rows.length > 0;
}

/** The contact this account has approved for the teams it captains, or null. */
async function readCaptainContact(db: BuilderQuery, userId: string): Promise<string | null> {
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
 * Prefer the linked Telegram username. Fall back to the previously saved
 * Captain contact, or null; never substitute a login email.
 */
export async function readCaptainHandle(db: BuilderQuery, userId: string): Promise<string | null> {
  const telegram = await getTelegramIdentity(userId, db);
  if (telegram?.username) return `@${telegram.username}`;
  return readCaptainContact(db, userId);
}
