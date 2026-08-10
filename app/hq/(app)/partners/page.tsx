import type { Metadata } from "next";
import { PartnersBoard } from "@/components/hq/partners-board";
import { requireUser } from "@/lib/hq/auth";
import { getClassifiers, getPartners } from "@/lib/hq/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Partners" };

export default async function PartnersPage() {
  const user = await requireUser();
  void user;
  const [partners, classifiers] = await Promise.all([getPartners(), getClassifiers()]);
  return <PartnersBoard partners={partners} classifiers={classifiers} />;
}
