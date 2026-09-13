import "server-only";
import { revalidatePath } from "next/cache";
import { assertHackathonMatches } from "../authz";
import { BuilderError } from "../builder-types";
import { getSql } from "../db";
import { todayInTz } from "../format";
import { getSettings } from "../queries";

/**
 * The loaded record when it belongs to the given edition, else null. Built
 * on `assertHackathonMatches`, which answers a missing record and one from
 * another edition the same way, so an id from a form or a swapped
 * `hq_hackathon` cookie reveals nothing about records outside the edition
 * the operator is working in. Operator actions that take a record id call
 * this and return their usual not-found result on null.
 */
export function inHackathon<T extends { hackathonId: number }>(record: T | null | undefined, hackathonId: number): T | null {
  try {
    return assertHackathonMatches(record, hackathonId);
  } catch (error) {
    if (error instanceof BuilderError) return null;
    throw error;
  }
}

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
