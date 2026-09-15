import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BuilderShell } from "@/components/hq/builder-shell";
import { OwnReportingNotes } from "@/components/hq/reporting-own-notes";
import { requireMemberActor } from "@/lib/hq/actor";
import { builderDatabase } from "@/lib/hq/builder-db";
import { builderStore } from "@/lib/hq/builder-store";
import { readOwnUpdates } from "@/lib/hq/reporting";

export const metadata: Metadata = { title: "Your notes" };
export const dynamic = "force-dynamic";

/**
 * Everything this Captain has written, including on projects they no longer
 * hold.
 *
 * The permission contract has always said the author keeps a read-only view
 * of their own sensitive note "while their Captain capability is active", and
 * until this page nothing implemented it: `readAuthorizedUpdates` decides
 * `read` on the project before it applies the entry audience, so the moment
 * an admin reassigned a project its former Captain lost the notes they had
 * written on it. `readOwnUpdates` is the path that asks about the author
 * instead of the project.
 *
 * The gate is the same one `/hq/captain` uses, read from the grants for this
 * request. The service checks the capability again for itself, so a grant
 * revoked between the menu and the read closes the page rather than the
 * screen deciding on its own.
 */
export default async function CaptainNotesPage() {
  const actor = await requireMemberActor("/hq/captain/notes");
  if (!actor.capabilities.has("captain")) notFound();

  const hackathonId = await builderStore().currentHackathonId();
  const page = hackathonId === null
    ? { entries: [], nextCursor: null }
    : await readOwnUpdates(actor, { hackathonId, limit: 10 }, builderDatabase());

  return (
    <BuilderShell back="/hq/captain">
      <h1>Your <em>notes.</em></h1>
      <p>
        Every update you have written in this hackathon, including on teams you are no longer assigned to. These are your own words only; nothing
        else about a team you have left is shown here, and they cannot be changed from this page.
      </p>
      <OwnReportingNotes initial={page.entries} initialCursor={page.nextCursor} />
    </BuilderShell>
  );
}
