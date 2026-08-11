import type { Metadata } from "next";
import { Dashboard } from "@/components/hq/dashboard";
import { requireUser } from "@/lib/hq/auth";
import { nowMs, todayInTz, todayLabel } from "@/lib/hq/format";
import {
  getClassifiers,
  getMilestones,
  getProjects,
  getSettings,
} from "@/lib/hq/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const [, settings, projects, milestones, classifiers] = await Promise.all([
    requireUser(),
    getSettings(),
    getProjects(),
    getMilestones(),
    getClassifiers(),
  ]);
  const now = nowMs();
  return (
    <Dashboard
      settings={settings}
      projects={projects}
      milestones={milestones}
      classifiers={classifiers}
      now={now}
      todayText={todayLabel(settings.timezone)}
      todayIso={todayInTz(settings.timezone)}
    />
  );
}
