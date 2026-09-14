import type { Metadata } from "next";
import { Projects } from "@/components/hq/projects";
import { BuilderProjectReviews } from "@/components/hq/builder-admin";
import { getBuilderProjectReviews } from "@/lib/hq/builder-admin-queries";
import { requireUser } from "@/lib/hq/auth";
// The candidate list for the Captain picker: accounts with an active Captain
// grant, resolved here (server side, operator gated) rather than shipping
// every account to the client and filtering there. listCapabilityGrants is
// the same operator-only reader Admin's own Captain screen uses.
import { listCapabilityGrants } from "@/lib/hq/capabilities";
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
  const [, hackathon, projects, partners, eventOptions, classifiers, settings, onboarding, captainGrants] =
    await Promise.all([
      requireUser(),
      getHackathon(hackathonId),
      getProjects(hackathonId),
      getPartners(hackathonId),
      getEventOptions(hackathonId),
      getClassifiers(hackathonId),
      getSettings(hackathonId),
      getBuilderProjectReviews(),
      // Captain grants are account-global, not scoped to this edition — the
      // same rule Admin's own Captain controls follow.
      listCapabilityGrants({ capability: "captain", activeOnly: true }),
    ]);
  ensureHackathon(hackathon);
  const now = nowMs();
  return (
    <>
      <Projects
      projects={projects}
      partnerOptions={partners.map((p) => ({ id: p.id, name: p.name }))}
      eventOptions={eventOptions}
      captainOptions={captainGrants.map((g) => ({ id: g.userId, name: g.userName }))}
      classifiers={classifiers}
      settings={settings}
      now={now}
      today={todayInTz(settings.timezone)}
      expandId={typeof expand === "string" ? expand : null}
      />
      <BuilderProjectReviews {...onboarding} />
    </>
  );
}
