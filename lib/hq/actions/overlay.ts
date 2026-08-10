"use server";

import { currentUser } from "../auth";
import { getActivity, getSettings } from "../queries";
import type { ActivityItem } from "../types";

/** The activity drawer fetches on open so it's always fresh for every operator. */
export async function fetchActivity(): Promise<{
  items: ActivityItem[];
  timezone: string;
} | null> {
  const user = await currentUser();
  if (!user || user.mustChangePassword) return null;
  const [items, settings] = await Promise.all([getActivity(40), getSettings()]);
  return { items, timezone: settings.timezone };
}
