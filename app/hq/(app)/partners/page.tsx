import type { Metadata } from "next";
import { PartnersBoard } from "@/components/hq/partners-board";
import { requireUser } from "@/lib/hq/auth";
import { ensureHackathon, requireHackathonId } from "@/lib/hq/hackathon";
import { getClassifiers, getHackathon, getPartners } from "@/lib/hq/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Partners" };

export default async function PartnersPage() {
  const hackathonId = await requireHackathonId();
  const [, hackathon, partners, classifiers] = await Promise.all([
    requireUser(),
    getHackathon(hackathonId),
    getPartners(hackathonId),
    getClassifiers(hackathonId),
  ]);
  ensureHackathon(hackathon);
  return <PartnersBoard partners={partners} classifiers={classifiers} />;
}
