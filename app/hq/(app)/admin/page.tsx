import type { Metadata } from "next";
import { Admin } from "@/components/hq/admin";
import { requireUser } from "@/lib/hq/auth";
import { getMilestones, getSettings } from "@/lib/hq/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Admin" };

export default async function AdminPage() {
  const [, settings, milestones] = await Promise.all([
    requireUser(),
    getSettings(),
    getMilestones(),
  ]);
  return <Admin settings={settings} milestones={milestones} />;
}
