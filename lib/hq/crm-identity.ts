import "server-only";
import type { BuilderDatabase, BuilderQuery } from "./builder-store";
import { BuilderError } from "./builder-types";

/**
 * CRM person identity: one hq_crm_persons row per human, stable across
 * editions and independent of any login. Edition-specific People cards and
 * roster rows point at it through person_id.
 *
 * Every function takes the query handle it should write through. Inside a
 * BuilderDatabase.transaction callback that is the transaction client, so the
 * person write commits or rolls back with the caller's other writes. The
 * multi-statement link also accepts the database itself and then opens its
 * own transaction, so it can never leave half a link behind.
 *
 * A person is matched by account id, or provisionally by normalized Colosseum
 * username. Never by display name: two people may share one, and one person
 * may change theirs. The explicit correction path is `correctPersonMatch`
 * (task T1.2).
 */

/** Lower case, without a leading `@` or surrounding whitespace; null when nothing is left. */
export function normalizeColosseumUsername(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().replace(/^@+/, "").trim().toLowerCase();
  return value || null;
}

/** Runs `work` in a transaction of `db`'s own, or inside the caller's when `db` already is a transaction client. */
function atomically<T>(db: BuilderQuery | BuilderDatabase, work: (tx: BuilderQuery) => Promise<T>): Promise<T> {
  return "transaction" in db ? db.transaction(work) : work(db);
}

/** The person for a public account: found by account id, or created. Returns the person id. */
export async function ensurePersonForAccount(db: BuilderQuery, input: { userId: string; displayName: string }): Promise<string> {
  const { rows: found } = await db.query("SELECT id FROM hq_crm_persons WHERE builder_user_id=$1", [input.userId]);
  if (found.length) return String(found[0].id);
  // Two first syncs of one account can race to this insert. The loser lands
  // on the unique account key and the no-op update hands back the winner's id.
  const { rows } = await db.query(
    `INSERT INTO hq_crm_persons(display_name,builder_user_id) VALUES($1,$2)
     ON CONFLICT(builder_user_id) DO UPDATE SET builder_user_id=EXCLUDED.builder_user_id RETURNING id`,
    [input.displayName, input.userId],
  );
  return String(rows[0].id);
}

/**
 * The person for a Colosseum roster entry: found by normalized username, or
 * created. The username is a PROVISIONAL match key, the display name is only
 * stored. Returns the person id.
 */
export async function ensurePersonForRosterMember(db: BuilderQuery, input: { colosseumUsername: string; displayName: string }): Promise<string> {
  const key = normalizeColosseumUsername(input.colosseumUsername);
  if (!key) throw new BuilderError("A Colosseum username is needed to identify a roster member.");
  const { rows: found } = await db.query("SELECT id FROM hq_crm_persons WHERE normalized_colosseum_username=$1", [key]);
  if (found.length) return String(found[0].id);
  const { rows } = await db.query(
    `INSERT INTO hq_crm_persons(display_name,normalized_colosseum_username) VALUES($1,$2)
     ON CONFLICT(normalized_colosseum_username) WHERE normalized_colosseum_username IS NOT NULL
     DO UPDATE SET normalized_colosseum_username=EXCLUDED.normalized_colosseum_username RETURNING id`,
    [input.displayName, key],
  );
  return String(rows[0].id);
}

/**
 * Links a person to a public account and stamps the account's People cards
 * that do not carry a person yet. Refuses, without writing, when the person
 * already belongs to a different account or the account to a different
 * person: a wrong match is corrected explicitly, never re-pointed here.
 * Linking a person to the account it already has is a no-op.
 */
export async function linkPersonToAccount(db: BuilderQuery | BuilderDatabase, input: { personId: string; userId: string }): Promise<void> {
  await atomically(db, async (tx) => {
    const { rows: persons } = await tx.query("SELECT builder_user_id FROM hq_crm_persons WHERE id=$1 FOR UPDATE", [input.personId]);
    if (!persons.length) throw new BuilderError("This person is no longer in the CRM.");
    const current = persons[0].builder_user_id;
    if (current != null && String(current) !== input.userId) throw new BuilderError("This person is already linked to another account.");
    const { rows: accounts } = await tx.query("SELECT 1 FROM hq_builder_profiles WHERE id=$1", [input.userId]);
    if (!accounts.length) throw new BuilderError("This account no longer exists.");
    const { rows: others } = await tx.query("SELECT 1 FROM hq_crm_persons WHERE builder_user_id=$1 AND id<>$2", [input.userId, input.personId]);
    if (others.length) throw new BuilderError("This account is already linked to another person.");
    await tx.query("UPDATE hq_people SET person_id=$1 WHERE builder_user_id=$2 AND person_id IS NULL", [input.personId, input.userId]);
    await tx.query("UPDATE hq_crm_persons SET builder_user_id=$1,updated_at=now() WHERE id=$2", [input.userId, input.personId]);
  });
}
