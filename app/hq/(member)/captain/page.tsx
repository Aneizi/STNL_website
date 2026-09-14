import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BuilderShell } from "@/components/hq/builder-shell";
import styles from "@/components/hq/builder-shell.module.css";
import { requireMemberActor } from "@/lib/hq/actor";
import { builderDatabase } from "@/lib/hq/builder-db";
import { builderStore } from "@/lib/hq/builder-store";
import { PROJECT_STAGES } from "@/lib/hq/builder-types";
import { leaderboard, listAssignments } from "@/lib/hq/captains";
import { toCaptainAssignmentView, type CaptainAssignmentView } from "@/lib/hq/view-models";

export const metadata: Metadata = { title: "Captain" };
export const dynamic = "force-dynamic";

const STAGE_LABELS: Record<string, string> = Object.fromEntries(PROJECT_STAGES.map((stage) => [stage.value, stage.label]));

/**
 * A current assignment whose project has no self-serve team yet: an
 * hq_projects row an admin added directly (CRM outreach, never imported
 * from Colosseum) has no hq_project_onboarding row, so there is no roster,
 * lead or Colosseum link for `toCaptainAssignmentView` to build from — the
 * project's own name is all there is to show. `builderStore().teamById`
 * returns null for these; see the report for why this stays a reduced row
 * instead of inventing fields BuilderTeam does not have.
 */
type BareAssignment = { projectId: string; projectName: string };

function isTeamView(view: CaptainAssignmentView | BareAssignment): view is CaptainAssignmentView {
  return "id" in view;
}

// The captain module. The gate is the member session, then the capability
// read from the grants for this request, never the menu that led here: an
// account without the grant gets the same not-found page as a URL that does
// not exist.
export default async function CaptainPage() {
  const actor = await requireMemberActor("/hq/captain");
  if (!actor.capabilities.has("captain")) notFound();

  // Member surfaces have no edition selector and must never read the
  // operator hq_hackathon cookie: the current edition is the same
  // server-side pick hackathons() and a fresh account's own enrollment use.
  const store = builderStore();
  const hackathonId = await store.currentHackathonId();
  const db = builderDatabase();
  const [assignments, board] = hackathonId === null
    ? [[], []]
    : await Promise.all([
        listAssignments(db, { hackathonId, captainUserId: actor.id }),
        leaderboard(db, hackathonId, actor.id),
      ]);
  const teams = await Promise.all(assignments.map((assignment) => store.teamById(assignment.projectId)));
  const views: Array<CaptainAssignmentView | BareAssignment> = assignments.map((assignment, index) => {
    const team = teams[index];
    return team ? toCaptainAssignmentView(team) : { projectId: assignment.projectId, projectName: assignment.projectName };
  });

  return (
    <BuilderShell>
      <h1>Your <em>assignments.</em></h1>
      {views.length === 0 && <p>No assignments yet. Assignments appear here once an admin assigns you a team.</p>}
      {views.map((view) => isTeamView(view) ? (
        <section key={view.id} className={styles.card}>
          <h2>{view.name}</h2>
          <p>{STAGE_LABELS[view.stage] ?? view.stage}</p>
          <p><a className={styles.inlineLink} href={view.projectUrl} target="_blank" rel="noopener noreferrer">View project on Colosseum</a></p>
          <p>Lead: @{view.lead.username}</p>
          {view.roster.map((member) => (
            <div className={styles.row} key={member.username || member.name}>
              <div>{member.name}{member.username === view.lead.username ? " (lead)" : ""}</div>
              <span>{member.joined ? "Joined" : "Not joined"}</span>
            </div>
          ))}
        </section>
      ) : (
        <section key={view.projectId} className={styles.card}>
          <h2>{view.projectName}</h2>
          <p>No further team details are available for this project yet.</p>
        </section>
      ))}

      <section aria-labelledby="captain-leaderboard-title">
        <h2 id="captain-leaderboard-title">Captain leaderboard</h2>
        {board.length === 0 && <p>No eligible Captains yet.</p>}
        {board.length > 0 && (
          <ol aria-label="Captain leaderboard">
            {board.map((row) => (
              <li className={styles.row} key={row.rank}>
                <span>{row.rank}. {row.displayName}{row.isYou ? " (you)" : ""}</span>
                <span>{row.assignedCount} project{row.assignedCount === 1 ? "" : "s"}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {!actor.telegram && (
        <section className={styles.notice} aria-labelledby="captain-telegram">
          <h2 id="captain-telegram">Connect Telegram</h2>
          <p>Captains can use the HQ bot on Telegram for reminders and updates once it is ready. Connecting is optional and never changes your account, your teams or your roles.</p>
          <Link className={styles.button} href="/hq/account">Connect Telegram</Link>
        </section>
      )}
    </BuilderShell>
  );
}
