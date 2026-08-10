import "server-only";
import { revalidatePath } from "next/cache";
import { getSql } from "../db";
import { todayInTz } from "../format";
import { getSettings } from "../queries";

/** Today's date stamp in the campaign timezone (check-ins, touch()). */
export async function hqToday(): Promise<string> {
  const settings = await getSettings();
  return todayInTz(settings.timezone);
}

/** Unexecuted activity INSERT for batching into a transaction. */
export function activityStmt(userId: string, message: string) {
  const sql = getSql();
  return sql`INSERT INTO hq_activity (user_id, message) VALUES (${userId}, ${message})`;
}

/** Invalidate every /hq page after a mutation. */
export function refreshHq() {
  revalidatePath("/hq", "layout");
}
