"use server";

import { currentUser } from "../auth";
import { selectedHackathonId } from "../hackathon";
import { getActivity, getSettings } from "../queries";
import type { ActivityItem } from "../types";

/**
 * The activity drawer fetches on open so it's always fresh for every operator.
 * Scoped to the hackathon being shown; with none chosen there is no feed.
 */
export async function fetchActivity(): Promise<{
  items: ActivityItem[];
  timezone: string;
} | null> {
  const user = await currentUser();
  if (!user || user.mustChangePassword) return null;
  const hackathonId = await selectedHackathonId();
  if (!hackathonId) return null;
  const [items, settings] = await Promise.all([
    getActivity(hackathonId, 40),
    getSettings(hackathonId),
  ]);
  return { items, timezone: settings.timezone };
}
