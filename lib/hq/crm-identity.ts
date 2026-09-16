import "server-only";
import { recordAuditEvent } from "./audit";
import type { AuditActor } from "./audit-sql";
import { atomically, type BuilderDatabase, type BuilderQuery } from "./builder-db";
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
 * may change theirs. The explicit correction path is `correctPersonMatch`,
 * an operator action with a reason and an audit event.
 */

/**
 * The one card per person per edition rule (hq_people_person_idx) as a
 * predicate over the card being updated: true when no other card of the same
 * edition carries the person. `personParam` is the positional parameter that
 * holds that person's id, so a caller says which uuid is being guarded
 * against instead of relying on parameter order.
 */
const noCardInEdition = (personParam: number) =>
  `NOT EXISTS (SELECT 1 FROM hq_people q WHERE q.hackathon_id = hq_people.hackathon_id AND q.person_id = $${personParam})`;

/**
 * Stamps the account's People cards that carry no person yet with `personId`,
 * skipping an edition where another card already carries it. Returns the ids
 * of the cards stamped.
 */
async function stampAccountCards(tx: BuilderQuery, input: { personId: string; userId: string }): Promise<string[]> {
  const { rows } = await tx.query(
    `UPDATE hq_people SET person_id=$1 WHERE builder_user_id=$2 AND person_id IS NULL AND ${noCardInEdition(1)} RETURNING id::text AS id`,
    [input.personId, input.userId],
  );
  return rows.map((row) => String(row.id));
}

/** Lower case, without a leading `@` or surrounding whitespace; null when nothing is left. */
export function normalizeColosseumUsername(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().replace(/^@+/, "").trim().toLowerCase();
  return value || null;
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
 * Refuses an identity change that would make an account a participant in a
 * project it currently captains.
 *
 * "A Captain cannot be assigned to a team they participate in" is an
 * invariant, not a rule about one direction of travel. `assignCaptain`
 * enforces it going one way, by refusing to assign an account that resolves
 * to a roster row of the project, and `redeemInvite` enforces it going
 * another, by refusing to let a Captain claim a seat on their own project.
 * The third way in was here: attaching a roster person to an account leaves
 * the account's existing Captain assignment untouched, and the assignment
 * lock `assignCaptain` takes cannot help, because that transaction is long
 * finished. So the same question is asked once more, at the moment the
 * relationship is actually created.
 *
 * Refused rather than repaired: silently ending an assignment would be an
 * unaudited Captain change made by a CRM correction, and which of the two is
 * wrong is the operator's call. The projects are named so the operator knows
 * which assignment to move first.
 *
 * What serialises this against a concurrent `assignCaptain` is the person
 * row, not this read: `checkCaptainConflict` there locks every CRM person on
 * the project's roster FOR UPDATE, and the callers below already hold
 * FOR UPDATE on the person being corrected, which is by definition one of
 * them. So the two orderings meet on a lock both already take, and this stays
 * a plain read.
 */
async function assertNoCaptainConflict(tx: BuilderQuery, input: { userId: string; personIds: string[] }): Promise<void> {
  const personIds = [...new Set(input.personIds.filter(Boolean))];
  if (!personIds.length) return;
  const { rows } = await tx.query(
    `SELECT p.name FROM hq_projects p
     WHERE EXISTS (SELECT 1 FROM hq_captain_assignments a
                   WHERE a.project_id = p.id AND a.captain_user_id = $1 AND a.unassigned_at IS NULL)
       AND EXISTS (SELECT 1 FROM hq_project_members m WHERE m.project_id = p.id AND m.person_id = ANY($2::uuid[]))
     ORDER BY p.name`,
    [input.userId, personIds],
  );
  if (!rows.length) return;
  const names = rows.map((row) => String(row.name)).join(", ");
  throw new BuilderError(
    `This account is the current Captain of ${names}, and this change would also make it a member of that team. Reassign the Captain first, then make the correction.`,
  );
}

/** Every CRM person a set of people is about, plus whichever persons the target account already carries roster rows through. */
async function rosterPersonsOf(tx: BuilderQuery, personIds: string[]): Promise<string[]> {
  const ids = [...new Set(personIds.filter(Boolean))];
  if (!ids.length) return [];
  const { rows } = await tx.query(
    "SELECT DISTINCT person_id::text AS person_id FROM hq_project_members WHERE person_id = ANY($1::uuid[])",
    [ids],
  );
  return rows.map((row) => String(row.person_id));
}

/**
 * Links a person to a public account and stamps the account's People cards
 * that do not carry a person yet. Refuses, without writing, when the person
 * already belongs to a different account or the account to a different
 * person: a wrong match is corrected explicitly, never re-pointed here.
 * Linking a person to the account it already has is a no-op. A card whose
 * edition already has another card for this person is left unstamped rather
 * than tripping the one card per person per edition index.
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
    // The person's roster rows become this account's the moment the link is
    // written, so the participant-and-Captain invariant is checked here,
    // before anything is.
    await assertNoCaptainConflict(tx, { userId: input.userId, personIds: await rosterPersonsOf(tx, [input.personId]) });
    await stampAccountCards(tx, { personId: input.personId, userId: input.userId });
    await tx.query("UPDATE hq_crm_persons SET builder_user_id=$1,updated_at=now() WHERE id=$2", [input.userId, input.personId]);
  });
}

export type PersonMatchCorrection = {
  /** False when the person already had exactly this link: nothing was written and no event recorded. */
  changed: boolean;
  personId: string;
  fromUserId: string | null;
  toUserId: string | null;
  /** The person the target account ends up with: `personId`, or the account's own person after a merge. For a clear, `personId` itself (see `deletedPersonId`). */
  survivingPersonId: string;
  /** `personId` when it was merged into the account's own person and deleted. */
  mergedPersonId: string | null;
  /** The fresh person the previously linked account received when the person was detached from it. */
  replacementPersonId: string | null;
  /** `personId` when a clear left it with no provisional key, no card and no roster row, so it was removed instead of orphaned. */
  deletedPersonId: string | null;
  /** People cards re-pointed to the surviving person. */
  movedCards: string[];
  /** People cards left without a person because their edition already had a card for the surviving person. */
  unlinkedCards: string[];
  movedRosterRows: number;
};

/**
 * The explicit correction path for a provisional match. An operator says
 * which account a person really is (`toUserId`) or that it is not the account
 * it was linked to (`toUserId: null`), with a reason. Never inferred from a
 * display name; the two ids are given.
 *
 * Detaching keeps the invariant that every account has one person of its
 * own: the old account's cards drop the person and get a fresh one. A cleared
 * person that has nothing left to identify it (no provisional Colosseum
 * username, no card, no roster row) is deleted rather than orphaned; one with
 * any of those is kept for a later explicit link. Attaching
 * links the person when the target account has none, and otherwise MERGES the
 * person into the account's own person: every People card and roster row is
 * re-pointed, a card whose edition already holds a card for the survivor is
 * left unlinked and reported, the provisional Colosseum username moves to the
 * survivor when it has none, and the merged person is deleted. All of it,
 * plus the `person.match_corrected` audit event, is one transaction.
 */
export async function correctPersonMatch(
  db: BuilderQuery | BuilderDatabase,
  input: { personId: string; toUserId: string | null; reason: string; actor: AuditActor },
): Promise<PersonMatchCorrection> {
  return atomically(db, async (tx) => {
    const { rows: persons } = await tx.query(
      "SELECT builder_user_id, display_name, normalized_colosseum_username FROM hq_crm_persons WHERE id=$1 FOR UPDATE",
      [input.personId],
    );
    if (!persons.length) throw new BuilderError("This person is no longer in the CRM.");
    const fromUserId = persons[0].builder_user_id == null ? null : String(persons[0].builder_user_id);
    // A team link may connect an unclaimed roster identity to its redeemer.
    // Moving a person away from another account remains an operator action,
    // because that move also changes cards and roster links in other teams.
    if (input.actor.kind !== "operator"
      && (input.actor.kind !== "member" || input.toUserId !== input.actor.id
        || (fromUserId !== null && fromUserId !== input.actor.id))) {
      throw new BuilderError("This roster identity is already linked to another HQ account. Ask an admin to check the match before joining.");
    }
    const result: PersonMatchCorrection = {
      changed: false, personId: input.personId, fromUserId, toUserId: input.toUserId,
      survivingPersonId: input.personId, mergedPersonId: null, replacementPersonId: null, deletedPersonId: null,
      movedCards: [], unlinkedCards: [], movedRosterRows: 0,
    };
    if (fromUserId === input.toUserId) return result;

    if (fromUserId !== null) {
      // Detach: the old account's cards stop pointing at this person, the
      // person is unlinked, and the account gets a person of its own again.
      await tx.query("UPDATE hq_people SET person_id=NULL WHERE builder_user_id=$1 AND person_id=$2", [fromUserId, input.personId]);
      await tx.query("UPDATE hq_crm_persons SET builder_user_id=NULL,updated_at=now() WHERE id=$1", [input.personId]);
      const { rows: profile } = await tx.query("SELECT name FROM hq_builder_profiles WHERE id=$1", [fromUserId]);
      if (profile.length) {
        const fresh = await ensurePersonForAccount(tx, { userId: fromUserId, displayName: String(profile[0].name) });
        result.replacementPersonId = fresh;
        await stampAccountCards(tx, { personId: fresh, userId: fromUserId });
      }
      if (input.toUserId === null) {
        // A clear, not a re-point: a person with nothing left to identify it
        // would only be an orphan, so it goes. Anything that still names it
        // (a provisional key, another card, a roster row) keeps it.
        const { rows: references } = await tx.query(
          `SELECT normalized_colosseum_username IS NOT NULL AS keyed,
             EXISTS (SELECT 1 FROM hq_people WHERE person_id=$1) AS has_cards,
             EXISTS (SELECT 1 FROM hq_project_members WHERE person_id=$1) AS has_roster
           FROM hq_crm_persons WHERE id=$1`,
          [input.personId],
        );
        if (references.length && !references[0].keyed && !references[0].has_cards && !references[0].has_roster) {
          await tx.query("DELETE FROM hq_crm_persons WHERE id=$1", [input.personId]);
          result.deletedPersonId = input.personId;
        }
      }
    }

    if (input.toUserId !== null) {
      const { rows: accounts } = await tx.query("SELECT name FROM hq_builder_profiles WHERE id=$1", [input.toUserId]);
      if (!accounts.length) throw new BuilderError("This account no longer exists.");
      const { rows: own } = await tx.query("SELECT id FROM hq_crm_persons WHERE builder_user_id=$1 FOR UPDATE", [input.toUserId]);
      // Both branches below end with `toUserId` carrying this person's roster
      // rows: the link branch by pointing the person at the account, the merge
      // branch by re-pointing every roster row onto the account's own person.
      // Either way the account ends up a participant in whatever those rows
      // belong to, so the check covers both persons before either is written.
      await assertNoCaptainConflict(tx, {
        userId: input.toUserId,
        personIds: await rosterPersonsOf(tx, [input.personId, ...own.map((row) => String(row.id))]),
      });
      if (!own.length) {
        await linkPersonToAccount(tx, { personId: input.personId, userId: input.toUserId });
        const { rows: unlinked } = await tx.query("SELECT id::text AS id FROM hq_people WHERE builder_user_id=$1 AND person_id IS NULL", [input.toUserId]);
        result.unlinkedCards = unlinked.map((row) => String(row.id));
      } else {
        const survivor = String(own[0].id);
        result.survivingPersonId = survivor;
        result.mergedPersonId = input.personId;
        // $1 is the survivor: the guard is against a card of the same
        // edition that already carries the survivor, not the merged person.
        const { rows: moved } = await tx.query(
          `UPDATE hq_people SET person_id=$1 WHERE person_id=$2 AND ${noCardInEdition(1)} RETURNING id::text AS id`,
          [survivor, input.personId],
        );
        result.movedCards = moved.map((row) => String(row.id));
        const { rows: unlinked } = await tx.query("UPDATE hq_people SET person_id=NULL WHERE person_id=$1 RETURNING id::text AS id", [input.personId]);
        result.unlinkedCards = unlinked.map((row) => String(row.id));
        const { rows: roster } = await tx.query("UPDATE hq_project_members SET person_id=$1 WHERE person_id=$2 RETURNING id", [survivor, input.personId]);
        result.movedRosterRows = roster.length;
        // Nothing points at the merged person any more; delete it before its
        // provisional username can move to the survivor under the unique key.
        await tx.query("DELETE FROM hq_crm_persons WHERE id=$1", [input.personId]);
        await tx.query(
          "UPDATE hq_crm_persons SET normalized_colosseum_username=COALESCE(normalized_colosseum_username,$2),updated_at=now() WHERE id=$1",
          [survivor, persons[0].normalized_colosseum_username ?? null],
        );
        await stampAccountCards(tx, { personId: survivor, userId: input.toUserId });
      }
    }

    result.changed = true;
    await recordAuditEvent(tx, {
      kind: "person.match_corrected",
      actor: input.actor,
      subjectUserId: input.toUserId ?? fromUserId,
      metadata: {
        fromUserId, toUserId: input.toUserId, reason: input.reason,
        fromPersonId: input.personId, toPersonId: result.survivingPersonId,
        replacementPersonId: result.replacementPersonId, deletedPersonId: result.deletedPersonId,
        movedCards: result.movedCards, unlinkedCards: result.unlinkedCards, movedRosterRows: result.movedRosterRows,
        ...(result.mergedPersonId ? { mergedColosseumUsername: persons[0].normalized_colosseum_username ?? null } : {}),
      },
    });
    return result;
  });
}
