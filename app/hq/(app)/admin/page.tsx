import type { Metadata } from "next";
import { Admin } from "@/components/hq/admin";
import { BuilderAdmin } from "@/components/hq/builder-admin";
import { getBuilderAdminData } from "@/lib/hq/builder-admin-queries";
import { requireUser } from "@/lib/hq/auth";
import { ensureHackathon, requireHackathonId } from "@/lib/hq/hackathon";
import {
  getClassifiers,
  getHackathon,
  getHackathons,
  getMilestones,
  getSettings,
} from "@/lib/hq/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Admin" };

export default async function AdminPage() {
  const hackathonId = await requireHackathonId();
  const [, hackathon, hackathons, settings, milestones, classifiers, onboarding] = await Promise.all([
    requireUser(),
    getHackathon(hackathonId),
    getHackathons(),
    getSettings(hackathonId),
    getMilestones(hackathonId),
    getClassifiers(hackathonId),
    getBuilderAdminData(),
  ]);
  const current = ensureHackathon(hackathon);
  return (
    <>
      <Admin
      current={current}
      hackathons={hackathons}
      settings={settings}
      milestones={milestones}
      gates={classifiers.gates}
      />
      <BuilderAdmin {...onboarding} />
    </>
  );
}
