import type { Metadata } from "next";
import { DemoDay } from "@/components/hq/demo-day";
import { requireUser } from "@/lib/hq/auth";
import {
  getAwards,
  getDemoProjects,
  getFinalists,
  getGatesTotal,
  getJudges,
  getScores,
  getSettings,
} from "@/lib/hq/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Demo day" };

export default async function DemoDayPage() {
  const user = await requireUser();
  void user;
  const [projects, finalists, awards, scores, judges, gatesTotal, settings] =
    await Promise.all([
      getDemoProjects(),
      getFinalists(),
      getAwards(),
      getScores(),
      getJudges(),
      getGatesTotal(),
      getSettings(),
    ]);
  return (
    <DemoDay
      projects={projects}
      finalists={finalists}
      awards={awards}
      scores={scores}
      judges={judges}
      gatesTotal={gatesTotal}
      finalistCap={settings.finalistCap}
      verifiedOnlyFinalists={settings.verifiedOnlyFinalists}
    />
  );
}
