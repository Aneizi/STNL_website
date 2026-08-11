import type { Metadata } from "next";
import { Events } from "@/components/hq/events";
import { requireUser } from "@/lib/hq/auth";
import { nowMs, todayInTz } from "@/lib/hq/format";
import { getClassifiers, getEventsWithOutputs, getSettings } from "@/lib/hq/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Events" };

export default async function EventsPage(props: {
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const user = await requireUser();
  void user;
  const { view } = await props.searchParams;

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
