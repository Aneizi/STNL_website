import type { Metadata } from "next";
import { Projects } from "@/components/hq/projects";
import { requireUser } from "@/lib/hq/auth";
import { nowMs, todayInTz } from "@/lib/hq/format";
import { ensureHackathon, requireHackathonId } from "@/lib/hq/hackathon";
import {
  getClassifiers,
  getEventOptions,
  getHackathon,
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
  const hackathonId = await requireHackathonId();
  const [, hackathon, projects, partners, eventOptions, classifiers, settings] =
    await Promise.all([
      requireUser(),
      getHackathon(hackathonId),
      getProjects(hackathonId),
      getPartners(hackathonId),
      getEventOptions(hackathonId),
      getClassifiers(hackathonId),
      getSettings(hackathonId),
    ]);
  ensureHackathon(hackathon);
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
