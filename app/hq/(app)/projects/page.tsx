import type { Metadata } from "next";
import { ImportRequests } from "@/components/hq/import-requests";
import { Projects } from "@/components/hq/projects";
import { getImportRequests, getProjectReportingBoard } from "@/lib/hq/builder-admin-queries";
import { requireUser } from "@/lib/hq/auth";
// The candidate list for the Captain picker: accounts with an active Captain
// grant, resolved here (server side, operator gated) rather than shipping
// every account to the client and filtering there. listCapabilityGrants is
// the same operator-only reader Admin's own Captain screen uses.
import { listCapabilityGrants } from "@/lib/hq/capabilities";
import { nowMs } from "@/lib/hq/format";
import { ensureHackathon, requireHackathonId } from "@/lib/hq/hackathon";
import {
  getClassifiers,
  getHackathon,
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
  const [, hackathon, projects, classifiers, settings, importRequests, captainGrants, reporting] =
    await Promise.all([
      requireUser(),
      getHackathon(hackathonId),
      getProjects(hackathonId),
      getClassifiers(hackathonId),
      getSettings(hackathonId),
      getImportRequests(),
      // Captain grants are account-global, not scoped to this edition, the
      // same rule Admin's own Captain controls follow.
      listCapabilityGrants({ capability: "captain", activeOnly: true }),
      // Every project's weekly state for this edition in one grouped read,
      // never one request per project.
      getProjectReportingBoard(),
    ]);
  ensureHackathon(hackathon);
  return (
    <>
      <Projects
        projects={projects}
        captainOptions={captainGrants.map((g) => ({ id: g.userId, name: g.userName }))}
        reporting={reporting.statuses}
        classifiers={classifiers}
        settings={settings}
        now={nowMs()}
        expandId={typeof expand === "string" ? expand : null}
      />
      <ImportRequests requests={importRequests} />
    </>
  );
}
