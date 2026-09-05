import type { Metadata } from "next";
import { HackathonPicker } from "@/components/hq/hackathon-picker";
import { requireUser } from "@/lib/hq/auth";
import { selectedHackathonId } from "@/lib/hq/hackathon";
import { getHackathons } from "@/lib/hq/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Choose a hackathon" };

/**
 * Where every sign-in lands: one banner per hackathon, each a button that
 * opens that edition's HQ. Outside the (app) group on purpose — there is no
 * chrome to show until a hackathon has been chosen.
 */
export default async function SelectHackathonPage() {
  const [user, hackathons, selectedId] = await Promise.all([
    requireUser(),
    getHackathons(),
    selectedHackathonId(),
  ]);
  return (
    <HackathonPicker
      hackathons={hackathons}
      selectedId={selectedId}
      displayName={user.displayName}
    />
  );
}
