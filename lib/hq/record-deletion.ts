import "server-only";
import { recordAuditEvent } from "./audit";
import { atomically, type BuilderDatabase, type BuilderQuery } from "./builder-db";

/**
 * Admin deletion of a team and of a person (owner requirement, 14 September
 * 2026). Operator-only; the gate and the edition scoping live in the calling
 * Server Actions (`lib/hq/actions/builders-admin.ts` and
 * `lib/hq/actions/people.ts`), which resolve the record through `inHackathon`
 * before calling anything here.
 *
 * Three rules the plan sets, and how each is met:
 *
 * 1. **"The confirmation states what else is removed or detached."** The
 *    counts come from `teamRemovalImpact` / `personRemovalImpact`, read
 *    before the destructive step for the confirmation and again inside the
 *    deleting transaction for the audit event, so the trail records what was
 *    actually removed rather than what the screen last showed.
 * 2. **"Deleting a person must not delete the HQ account behind them."** A
 *    People card is CRM, an `hq_builder_profiles` row is a login. Nothing
 *    here touches `hq_builder_profiles`, and `deletePersonRecord` says so in
 *    its result (`accountKept`).
 * 3. **"One transaction, and every dependent row either removed or explicitly
 *    detached."** Both functions run in one `BuilderDatabase.transaction`,
 *    with the audit event written inside it.
 *
 * WHAT POINTS AT THESE RECORDS, checked before the statements below were
 * written rather than assumed from the foreign keys:
 *
 * - at `hq_projects`: `hq_project_onboarding`, `hq_project_members`,
 *   `hq_project_gates`, `hq_project_notes`, `hq_finalists` (and through it
 *   `hq_scores` and `hq_awards.winner_project_id`), and phase 4's
 *   `hq_captain_assignments` — every one CASCADE except the award winner,
 *   which is SET NULL. `hq_team_invites` cascades from the onboarding row.
 *   Phase 5's reporting tables were added after this list was first written
 *   and are included here now: `hq_reporting_eligibility`,
 *   `hq_reporting_pause_intervals` (its pause history),
 *   `hq_reporting_entries` (and through it `hq_reporting_entry_revisions`)
 *   and `hq_reporting_outcomes`, every one CASCADE. `hq_project_ownership`
 *   (HQ ownership, 15 September 2026) cascades the same way, and
 *   `hq_project_import_requests.project_id` is SET NULL so a help request
 *   survives the project it became. Cascading is right for
 *   all four: a team's updates, its revision history, whether it was in
 *   reporting at all and what each week recorded are statements ABOUT that
 *   team, and none of them means anything once the team is gone — unlike an
 *   award, which outlives its winner. `hq_reporting_periods` is deliberately
 *   NOT touched: the periods belong to the edition, not to any one project,
 *   and the other teams still report against them.
 *   Phase 7 (the Telegram bot) added four tables and DELIBERATELY pointed
 *   none of them here. `hq_telegram_drafts` and `hq_telegram_actions` carry a
 *   `project_id`, but as a plain uuid with no foreign key, the same shape
 *   `hq_reporting_entries.author_id` uses: both are transient chat state with
 *   an expiry of minutes to a day, every read of either re-authorizes against
 *   the live project so a row pointing at a deleted one grants exactly
 *   nothing, and `purgeExpiredBotState` removes them on its own. Naming them
 *   here would put somebody's half-typed message into a confirmation that is
 *   supposed to be about the team's records. `hq_telegram_updates` and
 *   `hq_telegram_outgoing` never reference a project at all.
 *   Phase 10 (the final submission period) added
 *   `hq_submission_reconciliations`, which DOES point here: it names a
 *   project and a period, and it cascades from both. That is right for the
 *   same reason the reporting rows are: a reconciliation is a statement about
 *   one team's submission, and it means nothing once the team is gone. It is
 *   not counted in the confirmation, because what it holds is evidence about
 *   the recorded week beside it rather than anything a person wrote; the week
 *   itself is already counted.
 *   Phase 8 (the reminder and closure jobs) added `hq_reminder_deliveries`
 *   and deliberately pointed it at none of the three. It references the Captain's
 *   account, the edition and the reporting period, and it counts the teams a
 *   reminder named without naming them: a reminder is a statement about a
 *   Captain's week, not about any one team, and a deleted team's name must
 *   not outlive the team inside a history table. Deleting a team therefore
 *   leaves the reminder record intact and correct (its count describes what
 *   was outstanding on the day), and the confirmation stays about the team's
 *   own records.
 * - at `hq_people`: `hq_scores.judge_id` (CASCADE).
 * - at `hq_crm_persons`: `hq_people.person_id` and
 *   `hq_project_members.person_id` (both SET NULL — detachment, not
 *   cascade), and `hq_crm_persons.builder_user_id`, which is the link to the
 *   account and disappears with the person row, never with the account.
 *
 * **Nothing points at a person or a CRM person from the reporting tables or
 * from the reminder deliveries**,
 * which is why `deletePersonRecord` needed no change for phase 5 and is
 * stated here rather than left to be rediscovered. An entry's author is
 * `author_kind`/`author_id` with no foreign key — the same shape
 * `hq_audit_events.actor_kind`/`actor_id` uses, and for the same reason: the
 * author may be a public account or an operator, and the row must outlive
 * both. Even if it were a foreign key it would change nothing here, because
 * deleting a People card never deletes the `hq_builder_profiles` account
 * behind it (rule 2 above), so the account an entry names is still there
 * afterwards. A person's updates therefore survive their People card, which
 * is correct: the card is an edition's CRM entry, the updates are a team's
 * record of its own weeks.
 */

export type TeamRemovalImpact = {
  projectId: string;
  name: string;
  hackathonId: number;
  /** Whether the project came from a Colosseum import at all (a hand-added Admin project has no onboarding row). */
  imported: boolean;
  rosterRows: number;
  /** Unused join links that stop working. Used ones are counted in `joinLinksTotal`. */
  openJoinLinks: number;
  joinLinksTotal: number;
  /** A current Captain assignment this deletion ends, 0 or 1. */
  currentCaptain: number;
  captainHistory: number;
  notes: number;
  gates: number;
  finalist: boolean;
  judgeScores: number;
  /** Whether the project is in weekly reporting at all (phase 5). */
  reportingEnrolled: boolean;
  /** Reporting entries that go with it, voided ones included: the whole record, not only what a team could still see. */
  reportingEntries: number;
  /** Every version of every one of those entries. History is the reason this is counted separately from the entries. */
  reportingRevisions: number;
  /** Closed-period outcomes, the record of which weeks this team made and missed. */
  reportingOutcomes: number;
};

const count = (value: unknown) => Number(value ?? 0);

/** One row per project. `$WHERE` is the only part that differs between the single and batched reads. */
const TEAM_REMOVAL_SELECT =
    `SELECT p.id::text AS id, p.name, p.hackathon_id,
       EXISTS (SELECT 1 FROM hq_project_onboarding o WHERE o.project_id = p.id) AS imported,
       (SELECT count(*) FROM hq_project_members m WHERE m.project_id = p.id) AS roster_rows,
       (SELECT count(*) FROM hq_team_invites i WHERE i.project_id = p.id AND i.consumed_at IS NULL) AS open_join_links,
       (SELECT count(*) FROM hq_team_invites i WHERE i.project_id = p.id) AS join_links_total,
       (SELECT count(*) FROM hq_captain_assignments a WHERE a.project_id = p.id AND a.unassigned_at IS NULL AND a.captain_user_id IS NOT NULL) AS current_captain,
       (SELECT count(*) FROM hq_captain_assignments a WHERE a.project_id = p.id) AS captain_history,
       (SELECT count(*) FROM hq_project_notes n WHERE n.project_id = p.id) AS notes,
       (SELECT count(*) FROM hq_project_gates g WHERE g.project_id = p.id) AS gates,
       EXISTS (SELECT 1 FROM hq_finalists f WHERE f.project_id = p.id) AS finalist,
       (SELECT count(*) FROM hq_scores s WHERE s.project_id = p.id) AS judge_scores,
       EXISTS (SELECT 1 FROM hq_reporting_eligibility re WHERE re.project_id = p.id) AS reporting_enrolled,
       (SELECT count(*) FROM hq_reporting_entries e WHERE e.project_id = p.id) AS reporting_entries,
       (SELECT count(*) FROM hq_reporting_entry_revisions v
          JOIN hq_reporting_entries e ON e.id = v.entry_id WHERE e.project_id = p.id) AS reporting_revisions,
       (SELECT count(*) FROM hq_reporting_outcomes o WHERE o.project_id = p.id) AS reporting_outcomes
     FROM hq_projects p WHERE $WHERE`;

const toTeamRemoval = (row: Record<string, unknown>): TeamRemovalImpact => ({
  projectId: String(row.id), name: String(row.name), hackathonId: Number(row.hackathon_id),
  imported: Boolean(row.imported), rosterRows: count(row.roster_rows),
  openJoinLinks: count(row.open_join_links), joinLinksTotal: count(row.join_links_total),
  currentCaptain: count(row.current_captain), captainHistory: count(row.captain_history),
  notes: count(row.notes), gates: count(row.gates), finalist: Boolean(row.finalist),
  judgeScores: count(row.judge_scores),
  reportingEnrolled: Boolean(row.reporting_enrolled), reportingEntries: count(row.reporting_entries),
  reportingRevisions: count(row.reporting_revisions), reportingOutcomes: count(row.reporting_outcomes),
});

/**
 * The same read for a whole page of projects, in one query rather than one
 * per row: Admin's "Imported teams" panel needs every Delete team
 * confirmation's counts on every render, and a listing of a hundred teams is
 * a hundred round trips over the HTTP driver otherwise.
 */
export async function teamRemovalImpacts(db: BuilderQuery, projectIds: string[]): Promise<Map<string, TeamRemovalImpact>> {
  if (!projectIds.length) return new Map();
  const { rows } = await db.query(TEAM_REMOVAL_SELECT.replace("$WHERE", "p.id = ANY($1::uuid[])"), [projectIds]);
  return new Map(rows.map((row) => [String(row.id), toTeamRemoval(row)]));
}

/** What deleting this project takes with it. Read before the destructive step, and again inside it. */
export async function teamRemovalImpact(db: BuilderQuery, projectId: string): Promise<TeamRemovalImpact | null> {
  const { rows } = await db.query(TEAM_REMOVAL_SELECT.replace("$WHERE", "p.id = $1::uuid"), [projectId]);
  return rows.length ? toTeamRemoval(rows[0]) : null;
}

/**
 * Deletes a project and everything that belongs to it, in one transaction.
 *
 * The dependent rows go by cascade, which is deliberate here rather than
 * incidental: each of them is meaningless without the project (a roster of a
 * team that does not exist, a join link into it, who captained it, its notes
 * and gates). The one relationship that is NOT a cascade is
 * `hq_awards.winner_project_id`, which is SET NULL: an award outlives the
 * project that won it, and the operator is told the award loses its winner.
 */
export async function deleteTeamRecord(
  db: BuilderDatabase | BuilderQuery,
  input: { projectId: string; hackathonId: number; operatorId: string },
): Promise<TeamRemovalImpact | null> {
  return atomically(db, async (tx) => {
    const impact = await teamRemovalImpact(tx, input.projectId);
    if (!impact || impact.hackathonId !== input.hackathonId) return null;
    const { rows } = await tx.query("DELETE FROM hq_projects WHERE id = $1::uuid AND hackathon_id = $2 RETURNING id", [input.projectId, input.hackathonId]);
    if (!rows.length) return null;
    await recordAuditEvent(tx, {
      kind: "project.deleted",
      actor: { kind: "operator", id: input.operatorId },
      hackathonId: impact.hackathonId,
      // The project id is recorded as metadata, not as the event's own
      // project_id: hq_audit_events.project_id has no foreign key, but a
      // reader joining it to hq_projects would find nothing, and an audit row
      // that looks like it points at a live project is worse than one that
      // plainly records an id that is gone.
      metadata: {
        projectId: impact.projectId, name: impact.name, imported: impact.imported,
        rosterRows: impact.rosterRows, joinLinks: impact.joinLinksTotal,
        currentCaptain: impact.currentCaptain, captainHistory: impact.captainHistory,
        notes: impact.notes, gates: impact.gates, finalist: impact.finalist, judgeScores: impact.judgeScores,
        reportingEnrolled: impact.reportingEnrolled, reportingEntries: impact.reportingEntries,
        reportingRevisions: impact.reportingRevisions, reportingOutcomes: impact.reportingOutcomes,
      },
    });
    await tx.query("INSERT INTO hq_activity (hackathon_id, user_id, message) VALUES ($1, $2::uuid, $3)",
      [impact.hackathonId, input.operatorId, `Deleted the team ${impact.name}`]);
    return impact;
  });
}

export type PersonRemovalImpact = {
  cardId: string;
  name: string;
  hackathonId: number;
  personId: string | null;
  /** True when a People card is linked to an HQ account. The account is never deleted. */
  hasAccount: boolean;
  /** Roster rows that stop pointing at this person (detached, never deleted). */
  rosterRows: number;
  /** People cards for the same person in other editions. While any exist, the CRM person survives this deletion. */
  otherEditionCards: number;
  /** Demo-day scores this person gave as a judge. They go with the card. */
  judgeScores: number;
  /** Whether the account's enrollment in this edition goes with the card. */
  enrollments: number;
};

export async function personRemovalImpact(db: BuilderQuery, cardId: string): Promise<PersonRemovalImpact | null> {
  const { rows } = await db.query(
    `SELECT p.id::text AS id, p.name, p.hackathon_id, p.person_id::text AS person_id, p.builder_user_id,
       (SELECT count(*) FROM hq_scores s WHERE s.judge_id = p.id) AS judge_scores,
       (SELECT count(*) FROM hq_project_members m WHERE p.person_id IS NOT NULL AND m.person_id = p.person_id) AS roster_rows,
       (SELECT count(*) FROM hq_people q WHERE p.person_id IS NOT NULL AND q.person_id = p.person_id AND q.id <> p.id) AS other_cards,
       (SELECT count(*) FROM hq_builder_enrollments e WHERE p.builder_user_id IS NOT NULL AND e.user_id = p.builder_user_id AND e.hackathon_id = p.hackathon_id) AS enrollments
     FROM hq_people p WHERE p.id = $1::uuid`,
    [cardId],
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    cardId: String(row.id), name: String(row.name), hackathonId: Number(row.hackathon_id),
    personId: row.person_id == null ? null : String(row.person_id),
    hasAccount: row.builder_user_id != null,
    rosterRows: count(row.roster_rows), otherEditionCards: count(row.other_cards),
    judgeScores: count(row.judge_scores), enrollments: count(row.enrollments),
  };
}

export type PersonRemoval = PersonRemovalImpact & {
  /** Always true: an account is a login, a person is a CRM identity, and this never touches the former. */
  accountKept: true;
  /** True when this was the person's last People card, so the CRM person itself was removed and its roster rows detached. */
  crmPersonDeleted: boolean;
};

/**
 * Deletes a People card, and with it the CRM person when this was that
 * person's last card anywhere.
 *
 * The account behind the card is deliberately untouched: the person can sign
 * in tomorrow and `ensurePersonForAccount` will give them a fresh CRM person,
 * which is the correct outcome for "this card should not be here", and the
 * only outcome that does not turn a CRM clean-up into an account deletion.
 * Roster rows are detached (`person_id` becomes NULL through the foreign
 * key's SET NULL), never deleted: a roster row is the imported team's record
 * of who was on it, not HQ's record of a person.
 */
export async function deletePersonRecord(
  db: BuilderDatabase | BuilderQuery,
  input: { cardId: string; hackathonId: number; operatorId: string },
): Promise<PersonRemoval | null> {
  return atomically(db, async (tx) => {
    const impact = await personRemovalImpact(tx, input.cardId);
    if (!impact || impact.hackathonId !== input.hackathonId) return null;
    const { rows: deleted } = await tx.query("DELETE FROM hq_people WHERE id = $1::uuid AND hackathon_id = $2 RETURNING builder_user_id", [input.cardId, input.hackathonId]);
    if (!deleted.length) return null;
    const accountId = deleted[0].builder_user_id == null ? null : String(deleted[0].builder_user_id);
    if (accountId) {
      // Without this the account's next `enroll()` would simply recreate the
      // card the operator just removed.
      await tx.query("DELETE FROM hq_builder_enrollments WHERE user_id = $1 AND hackathon_id = $2", [accountId, input.hackathonId]);
    }
    let crmPersonDeleted = false;
    if (impact.personId && impact.otherEditionCards === 0) {
      const { rows } = await tx.query("DELETE FROM hq_crm_persons WHERE id = $1::uuid RETURNING id", [impact.personId]);
      crmPersonDeleted = rows.length > 0;
    }
    const removal: PersonRemoval = { ...impact, accountKept: true, crmPersonDeleted };
    await recordAuditEvent(tx, {
      kind: "person.deleted",
      actor: { kind: "operator", id: input.operatorId },
      hackathonId: impact.hackathonId,
      subjectUserId: accountId,
      metadata: {
        cardId: impact.cardId, name: impact.name, personId: impact.personId,
        crmPersonDeleted, detachedRosterRows: crmPersonDeleted ? impact.rosterRows : 0,
        otherEditionCards: impact.otherEditionCards, judgeScores: impact.judgeScores,
        enrollmentsRemoved: accountId ? impact.enrollments : 0, accountKept: true,
      },
    });
    await tx.query("INSERT INTO hq_activity (hackathon_id, user_id, message) VALUES ($1, $2::uuid, $3)",
      [impact.hackathonId, input.operatorId, `Deleted ${impact.name} from people`]);
    return removal;
  });
}
