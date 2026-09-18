import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BuilderCaptainDen, type CaptainDenTeam } from "@/components/hq/builder-captain-den";
import { BuilderShell } from "@/components/hq/builder-shell";
import { requireMemberActor } from "@/lib/hq/actor";
import { builderDatabase } from "@/lib/hq/builder-db";
import { builderStore } from "@/lib/hq/builder-store";
import { nowMs } from "@/lib/hq/format";
import { captainReportingBoard, type CaptainReportingCard } from "@/lib/hq/reporting-surface";
import { byOutstandingFirst } from "@/lib/hq/reporting-view";
import type { BuilderTeam } from "@/lib/hq/builder-types";

export const metadata: Metadata = { title: "Captains' Den" };
export const dynamic = "force-dynamic";

/**
 * One card as the Den's client component receives it: the reporting facts
 * the screen prints and the imported team's roster, lead and Colosseum link
 * where the project has them. The service row (`card.status`) is read here
 * for ordering and identity and never serialized: it carries the Captain's
 * account id and the eligibility date. The team's `description` stays on the
 * server for the same reason.
 *
 * An hq_projects row an admin added directly (CRM outreach, never imported
 * from Colosseum) has no hq_project_onboarding row, so `teamById` answers
 * null: the Den then lists no builders and offers no Colosseum link, and the
 * week, the status and the note form are the same as for an imported team.
 */
function toDenTeam(card: CaptainReportingCard, team: BuilderTeam | null): CaptainDenTeam {
  return {
    projectId: card.status.projectId,
    hackathonId: card.status.hackathonId,
    name: card.status.projectName,
    paused: card.status.paused,
    current: card.current ? { periodId: card.current.periodId, endsAt: card.current.endsAt, completed: card.current.completed } : null,
    roster: team ? team.members.map((member) => ({ name: member.name, username: member.username, joined: member.joined })) : [],
    leadUsername: team?.leadUsername ?? null,
    projectUrl: team?.projectUrl ?? null,
    teamContact: card.teamContact,
    entries: card.entries,
    nextCursor: card.nextCursor,
  };
}

// The Captains' Den. The gate is the member session, then the capability
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
  // One request instant, read before the board and passed into it, so the
  // week the board decided and the due line this page prints answer to the
  // same moment.
  const at = nowMs();
  const board = hackathonId === null ? null : await captainReportingBoard(actor, hackathonId, db, at);
  // The teams still needing this week's update first, as the aside lists
  // them and as the first one is selected. The imported detail, where there
  // is any: one lookup per assigned project, safe here only because every id
  // comes from this Captain's own assignments on the board.
  const cards = [...(board?.cards ?? [])].sort((a, b) => byOutstandingFirst(a.status, b.status));
  const teams = await Promise.all(cards.map((card) => store.teamById(card.status.projectId)));

  return (
    <BuilderShell bare>
      <BuilderCaptainDen
        teams={cards.map((card, index) => toDenTeam(card, teams[index]))}
        week={board?.week ?? null}
        timezone={board?.timezone ?? "Europe/Amsterdam"}
        contact={board?.captainContact ?? null}
      />
    </BuilderShell>
  );
}
