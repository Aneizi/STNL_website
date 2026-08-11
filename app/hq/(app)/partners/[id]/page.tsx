import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PartnerDetail } from "@/components/hq/partner-detail";
import { requireUser } from "@/lib/hq/auth";
import { getClassifiers, getPartnerDetail, getSettings } from "@/lib/hq/queries";

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
  const [user, partner, classifiers, settings] = await Promise.all([
    requireUser(),
    getPartnerDetail(id),
    getClassifiers(),
    getSettings(),
  ]);
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
