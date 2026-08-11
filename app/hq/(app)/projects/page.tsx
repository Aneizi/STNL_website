import type { Metadata } from "next";
import { Projects } from "@/components/hq/projects";
import { requireUser } from "@/lib/hq/auth";
import { nowMs, todayInTz } from "@/lib/hq/format";
import {
  getClassifiers,
  getEventOptions,
  getPartners,
  getProjects,
  getSettings,
} from "@/lib/hq/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Projects" };

export default async function ProjectsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { expand } = await props.searchParams;
  const [, projects, partners, eventOptions, classifiers, settings] = await Promise.all([
    requireUser(),
    getProjects(),
    getPartners(),
    getEventOptions(),
    getClassifiers(),
    getSettings(),
  ]);
  const now = nowMs();
  return (
    <Projects
      projects={projects}
      partnerOptions={partners.map((p) => ({ id: p.id, name: p.name }))}
      eventOptions={eventOptions}
      classifiers={classifiers}
      settings={settings}
      now={now}
      today={todayInTz(settings.timezone)}
      expandId={typeof expand === "string" ? expand : null}
    />
  );
}
