import "server-only";
import { recordAuditEvent } from "./audit";
import { atomically, type BuilderDatabase, type BuilderQuery } from "./builder-db";

/**
 * Operator actions authorize and scope records before calling these services.
 * Deletion, audit and activity writes share one transaction; impact counts are
 * reread inside it rather than trusting the confirmation screen.
 *
 * Project-owned imports, ownership, roster, invites, gates, notes, finalists,
 * scores, assignments, reporting rows and submission reconciliations cascade.
 * Awards lose their winner; import requests lose their project link. Edition
 * periods and Captain reminder history survive.
 *
 * Transient Telegram drafts/actions have no project foreign key. Every use
 * reauthorizes the live project, and expired state is purged separately.
 *
 * Deleting a People card removes its judge scores and enrollment, never its
 * login account. The last card also removes the CRM person and detaches roster
 * references with SET NULL. Reporting authorship survives CRM deletion.
 */

type TeamRemovalImpact = {
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
  /** Whether the project is enrolled in weekly reporting. */
  reportingEnrolled: boolean;
  /** Reporting entries that go with it, voided ones included: the whole record, not only what a team could still see. */
  reportingEntries: number;
  /** Every version of every one of those entries. History is the reason this is counted separately from the entries. */
  reportingRevisions: number;
  /** Closed-period outcomes, the record of which weeks this team made and missed. */
  reportingOutcomes: number;
};

const count = (value: unknown) => Number(value ?? 0);

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
     FROM hq_projects p WHERE p.id = $1::uuid`;

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

/** What deleting this project takes with it. Read inside the deleting transaction, for the audit event. */
export async function teamRemovalImpact(db: BuilderQuery, projectId: string): Promise<TeamRemovalImpact | null> {
  const { rows } = await db.query(TEAM_REMOVAL_SELECT, [projectId]);
  return rows.length ? toTeamRemoval(rows[0]) : null;
}

/**
 * Delete the project and its dependent records atomically. Awards survive with
 * their winner cleared (SET NULL).
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
      // Keep the deleted id in metadata rather than suggesting a live project link.
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

async function personRemovalImpact(db: BuilderQuery, cardId: string): Promise<PersonRemovalImpact | null> {
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

type PersonRemoval = PersonRemovalImpact & {
  /** Always true: an account is a login, a person is a CRM identity, and this never touches the former. */
  accountKept: true;
  /** True when this was the person's last People card, so the CRM person itself was removed and its roster rows detached. */
  crmPersonDeleted: boolean;
};

/**
 * Delete the People card and, if it was the last card, its CRM person.
 * Keep the login account and detach roster references rather than deleting
 * imported roster records. A later sign-in may recreate the CRM identity.
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
