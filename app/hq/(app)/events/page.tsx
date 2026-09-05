import type { Metadata } from "next";
import { Events } from "@/components/hq/events";
import { requireUser } from "@/lib/hq/auth";
import { nowMs, todayInTz } from "@/lib/hq/format";
import { ensureHackathon, requireHackathonId } from "@/lib/hq/hackathon";
import {
  getClassifiers,
  getEventsWithOutputs,
  getHackathon,
  getLumaSyncedAt,
  getSettings,
} from "@/lib/hq/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Events" };

export default async function EventsPage(props: {
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const { view } = await props.searchParams;
  const hackathonId = await requireHackathonId();

  const [, hackathon, events, classifiers, settings, syncedAt] = await Promise.all([
    requireUser(),
    getHackathon(hackathonId),
    getEventsWithOutputs(hackathonId),
    getClassifiers(hackathonId),
    getSettings(hackathonId),
    getLumaSyncedAt(),
  ]);
  ensureHackathon(hackathon);
  return (
    <Events
      events={events}
      classifiers={classifiers}
      settings={settings}
      now={nowMs()}
      today={todayInTz(settings.timezone)}
      syncedAt={syncedAt}
      view={Array.isArray(view) ? view[0] : view}
    />
  );
}
