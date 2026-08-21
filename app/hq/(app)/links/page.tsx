import type { Metadata } from "next";
import { Links } from "@/components/hq/links";
import { requireUser } from "@/lib/hq/auth";
import { getLinks, getSettings } from "@/lib/hq/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Links" };

export default async function LinksPage() {
  const [user, links, settings] = await Promise.all([
    requireUser(),
    getLinks(),
    getSettings(),
  ]);
  return <Links links={links} timezone={settings.timezone} userName={user.displayName} />;
}
