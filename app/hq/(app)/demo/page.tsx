import type { Metadata } from "next";
import { DemoDay } from "@/components/hq/demo-day";
import { requireUser } from "@/lib/hq/auth";
import { ensureHackathon, requireHackathonId } from "@/lib/hq/hackathon";
import {
  getAwards,
  getDemoProjects,
  getFinalists,
  getGatesTotal,
  getHackathon,
  getJudges,
  getScores,
  getSettings,
} from "@/lib/hq/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Demo day" };

export default async function DemoDayPage() {
  const hackathonId = await requireHackathonId();
  const [, hackathon, projects, finalists, awards, scores, judges, gatesTotal, settings] =
    await Promise.all([
      requireUser(),
      getHackathon(hackathonId),
      getDemoProjects(hackathonId),
      getFinalists(hackathonId),
      getAwards(hackathonId),
      getScores(hackathonId),
      getJudges(hackathonId),
      getGatesTotal(hackathonId),
      getSettings(hackathonId),
    ]);
  ensureHackathon(hackathon);
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
