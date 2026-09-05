import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PartnerDetail } from "@/components/hq/partner-detail";
import { requireUser } from "@/lib/hq/auth";
import { ensureHackathon, requireHackathonId } from "@/lib/hq/hackathon";
import { getClassifiers, getHackathon, getPartnerDetail, getSettings } from "@/lib/hq/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Partners" };

// getPartnerDetail feeds the raw id into a uuid column, which throws (not
// 404s) on malformed input — so shape-check before querying.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PartnerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const hackathonId = await requireHackathonId();
  const [user, hackathon, partner, classifiers, settings] = await Promise.all([
    requireUser(),
    getHackathon(hackathonId),
    // A partner of another hackathon is not found here, not shown out of place.
    getPartnerDetail(id, hackathonId),
    getClassifiers(hackathonId),
    getSettings(hackathonId),
  ]);
  ensureHackathon(hackathon);
  if (!partner) notFound();
  return (
    <PartnerDetail
      partner={partner}
      classifiers={classifiers}
      timezone={settings.timezone}
      userName={user.displayName}
    />
  );
}
