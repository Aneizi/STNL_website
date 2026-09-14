import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BuilderProjectImage } from "@/components/hq/builder-project-image";
import { BuilderShell } from "@/components/hq/builder-shell";
import styles from "@/components/hq/builder-shell.module.css";
import { CaptainContact, CaptainProjectCard } from "@/components/hq/reporting-member";
import { requireMemberActor } from "@/lib/hq/actor";
import { builderDatabase } from "@/lib/hq/builder-db";
import { builderStore } from "@/lib/hq/builder-store";
import { PROJECT_STAGES } from "@/lib/hq/builder-types";
import { leaderboard } from "@/lib/hq/captains";
import { SUBMISSION_LABELS } from "@/lib/hq/colosseum-snapshot";
import { nowMs } from "@/lib/hq/format";
import { captainReportingBoard } from "@/lib/hq/reporting-surface";
import { byOutstandingFirst } from "@/lib/hq/reporting-view";
import { toCaptainAssignmentView, type CaptainAssignmentView } from "@/lib/hq/view-models";

export const metadata: Metadata = { title: "Captain" };
export const dynamic = "force-dynamic";

const STAGE_LABELS: Record<string, string> = Object.fromEntries(PROJECT_STAGES.map((stage) => [stage.value, stage.label]));

/**
 * The imported team behind an assignment, when there is one.
 *
 * An hq_projects row an admin added directly (CRM outreach, never imported
 * from Colosseum) has no hq_project_onboarding row, so there is no roster,
 * lead or Colosseum link to show and `builderStore().teamById` returns null.
 * That is no longer a reduced card: reporting is keyed on hq_projects, so
 * the week, the status and the composer above are identical either way, and
 * this block is the extra a Colosseum import happens to carry.
 */
function ImportedTeamDetail({ view }: { view: CaptainAssignmentView }) {
  return (
    <>
      <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
        <BuilderProjectImage src={view.source.imageUrl} name={view.name} size={56} />
        <p style={{ margin: 0 }}>{STAGE_LABELS[view.stage] ?? view.stage}<br />Colosseum: {SUBMISSION_LABELS[view.source.submissionStatus]}</p>
      </div>
      <p><a className={styles.inlineLink} href={view.projectUrl} target="_blank" rel="noopener noreferrer">View project on Colosseum</a></p>
      <p>Lead: @{view.lead.username}</p>
      {view.roster.map((member) => (
        <div className={styles.row} key={member.username || member.name}>
          <div>{member.name}{member.username === view.lead.username ? " (lead)" : ""}</div>
          <span>{member.joined ? "Joined" : "Not joined"}</span>
        </div>
      ))}
    </>
  );
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
  const [board, ranking] = hackathonId === null
    ? [null, []]
    : await Promise.all([
        captainReportingBoard(actor, hackathonId, db),
        leaderboard(db, hackathonId, actor.id),
      ]);
  // The imported detail, where there is any. One lookup per assigned project,
  // and null is a perfectly good answer for a project the CRM created.
  const cards = [...(board?.cards ?? [])].sort((a, b) => byOutstandingFirst(a.status, b.status));
  const teams = await Promise.all(cards.map((card) => store.teamById(card.status.projectId)));
  const at = nowMs();

  return (
    <BuilderShell>
      <h1>Your <em>assignments.</em></h1>
      {cards.length === 0 && <p>No assignments yet. Assignments appear here once an admin assigns you a team.</p>}
      {cards.length > 0 && <p>Teams still needing this week&apos;s update come first.</p>}
      {cards.map((card, index) => {
        const team = teams[index];
        return (
          <CaptainProjectCard
            key={card.status.projectId}
            projectId={card.status.projectId}
            projectName={card.status.projectName}
            hackathonId={card.status.hackathonId}
            current={card.status.current}
            missedPeriods={card.status.missedPeriods}
            paused={card.status.paused}
            teamContact={card.teamContact}
            latest={card.latest}
            timezone={board?.timezone ?? "Europe/Amsterdam"}
            nowMs={at}
          >
            {team ? <ImportedTeamDetail view={toCaptainAssignmentView(team)} /> : <p>No Colosseum team is linked to this project.</p>}
          </CaptainProjectCard>
        );
      })}

      {cards.length > 0 && (
        <section aria-labelledby="captain-contact-title">
          <h2 id="captain-contact-title">Your contact</h2>
          <CaptainContact initial={board?.captainContact ?? null} />
        </section>
      )}

      <section aria-labelledby="captain-leaderboard-title">
        <h2 id="captain-leaderboard-title">Captain leaderboard</h2>
        {ranking.length === 0 && <p>No eligible Captains yet.</p>}
        {ranking.length > 0 && (
          <ol aria-label="Captain leaderboard">
            {ranking.map((row) => (
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
