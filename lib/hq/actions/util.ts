import "server-only";
import { revalidatePath } from "next/cache";
import { getSql } from "../db";
import { todayInTz } from "../format";
import { getSettings } from "../queries";

/** Today's date stamp in the hackathon's timezone (check-ins, touch()). */
export async function hqToday(hackathonId: number): Promise<string> {
  const settings = await getSettings(hackathonId);
  return todayInTz(settings.timezone);
}

/**
 * Unexecuted activity INSERT for batching into a transaction. Activity is per
 * hackathon; callers pass the hackathon of the record they touched, which
 * they already looked up, rather than whatever the cookie says.
 */
export function activityStmt(userId: string, hackathonId: number, message: string) {
  const sql = getSql();
  return sql`
    INSERT INTO hq_activity (hackathon_id, user_id, message)
    VALUES (${hackathonId}, ${userId}, ${message})
  `;
}

/** Invalidate every /hq page after a mutation. */
export function refreshHq() {
  revalidatePath("/hq", "layout");
}
