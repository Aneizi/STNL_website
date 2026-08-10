import type { Metadata } from "next";
import { Events } from "@/components/hq/events";
import { requireUser } from "@/lib/hq/auth";
import { nowMs, todayInTz } from "@/lib/hq/format";
import { syncLumaEvents } from "@/lib/hq/luma-sync";
import { getClassifiers, getEventsWithOutputs, getSettings } from "@/lib/hq/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Events" };

export default async function EventsPage(props: {
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const user = await requireUser();
  void user;
  const { view } = await props.searchParams;

  // Refresh the mirror before reading it. Throttled to once every five minutes
  // in the database — this route is force-dynamic, which per Next's docs forces
  // every fetch in it to no-store, so the public page's ISR throttle cannot
  // apply here. A failure is deliberately silent: the mirrored rows below are
  // still served, and the Sync Luma button surfaces errors on demand.
  await syncLumaEvents();

  const [events, classifiers, settings] = await Promise.all([
    getEventsWithOutputs(),
    getClassifiers(),
    getSettings(),
  ]);
  return (
    <Events
      events={events}
      classifiers={classifiers}
      settings={settings}
      now={nowMs()}
      today={todayInTz(settings.timezone)}
      view={Array.isArray(view) ? view[0] : view}
    />
  );
}
