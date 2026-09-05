import type { Metadata } from "next";
import { Links } from "@/components/hq/links";
import { requireUser } from "@/lib/hq/auth";
import { ensureHackathon, requireHackathonId } from "@/lib/hq/hackathon";
import { getHackathon, getLinks, getSettings } from "@/lib/hq/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Links" };

export default async function LinksPage() {
  const hackathonId = await requireHackathonId();
  const [user, hackathon, links, settings] = await Promise.all([
    requireUser(),
    getHackathon(hackathonId),
    getLinks(hackathonId),
    getSettings(hackathonId),
  ]);
  ensureHackathon(hackathon);
  return <Links links={links} timezone={settings.timezone} userName={user.displayName} />;
}
