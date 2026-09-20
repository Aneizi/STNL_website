import "server-only";
import { randomUUID } from "node:crypto";
import { ColosseumApiError, fetchColosseumUpdatePage, type ColosseumFetch, type ColosseumUpdate } from "@/lib/colosseum-api";
import type { Actor } from "./actor";
import { authorizeProjectAction } from "./authz-decisions";
import { loadCurrentAssignment, loadProjectEdition, loadTeamMembership } from "./authz-sql";
import { builderDatabase, type BuilderDatabase } from "./builder-db";
import { listActiveCapabilities } from "./capabilities";
import { toIso } from "./reporting-enrolment";

const SYNC_INTERVAL_MS = 30 * 60_000;
const RETRY_INTERVAL_MS = 15 * 60_000;
const LEASE_MS = 60_000;
type SyncOptions = { now?: number; fetcher?: ColosseumFetch };
export type ColosseumHistoryPage = {
  linked: boolean;
  updates: ColosseumUpdate[];
  nextCursor: string | null;
  syncingOlder: boolean;
  syncFailed: boolean;
};
type ColosseumHistoryInput = { projectId: string; hackathonId: number; cursor?: string };
export type ColosseumHistoryResult = { ok: true; page: ColosseumHistoryPage } | { ok: false; error: string };
const emptyPage = (): ColosseumHistoryPage => ({ linked: false, updates: [], nextCursor: null, syncingOlder: false, syncFailed: false });

/** Fetch one page per claim. Cursor progress and its records commit together.
 * There is no imported-at cutoff and no dependency on reporting enrollment. */
export async function syncColosseumUpdates(
  db: BuilderDatabase,
  projectId: string,
  options: SyncOptions = {},
): Promise<"synced" | "failed" | "skipped"> {
  const now = options.now ?? Date.now();
  const at = new Date(now).toISOString();
  await db.query(`INSERT INTO hq_colosseum_update_sync(project_id,next_attempt_at)
    SELECT project_id,$2::timestamptz FROM hq_project_onboarding WHERE project_id=$1::uuid
    ON CONFLICT (project_id) DO NOTHING`, [projectId, at]);
  const token = randomUUID();
  const { rows } = await db.query(`UPDATE hq_colosseum_update_sync s
    SET lease_token=$2::uuid,lease_until=$4::timestamptz
    FROM hq_project_onboarding o JOIN hq_hackathons h ON h.id=o.hackathon_id
    WHERE s.project_id=$1::uuid AND o.project_id=s.project_id AND h.archived_at IS NULL
      AND s.next_attempt_at <= $3::timestamptz AND (s.lease_until IS NULL OR s.lease_until <= $3::timestamptz)
    RETURNING s.cursor,o.project_url,o.external_id,o.external_hackathon_id`,
  [projectId, token, at, new Date(now + LEASE_MS).toISOString()]);
  const source = rows[0];
  if (!source) return "skipped";
  try {
    const page = await fetchColosseumUpdatePage({
      projectUrl: String(source.project_url), externalId: Number(source.external_id),
      externalHackathonId: source.external_hackathon_id == null ? null : Number(source.external_hackathon_id), cursor: source.cursor == null ? null : String(source.cursor),
    }, options.fetcher ?? fetch);
    await db.transaction(async tx => {
      const { rows: lease } = await tx.query(`SELECT 1 FROM hq_colosseum_update_sync
        WHERE project_id=$1::uuid AND lease_token=$2::uuid FOR UPDATE`, [projectId, token]);
      if (!lease.length) return;
      for (const update of page.updates) {
        await tx.query(`INSERT INTO hq_colosseum_updates
          (project_id,external_id,author_name,body,links,source_url,published_at,source_updated_at,fetched_at)
          VALUES($1::uuid,$2,$3,$4,$5::jsonb,$6,$7::timestamptz,$8::timestamptz,$9::timestamptz)
          ON CONFLICT (project_id,external_id) DO UPDATE SET author_name=EXCLUDED.author_name,body=EXCLUDED.body,
            links=EXCLUDED.links,source_url=EXCLUDED.source_url,published_at=EXCLUDED.published_at,
            source_updated_at=EXCLUDED.source_updated_at,fetched_at=EXCLUDED.fetched_at
          WHERE hq_colosseum_updates.source_updated_at <= EXCLUDED.source_updated_at`,
        [projectId, update.externalId, update.authorName, update.body, JSON.stringify(update.links), update.sourceUrl, update.publishedAt, update.updatedAt, at]);
      }
      await tx.query(`UPDATE hq_colosseum_update_sync SET cursor=$3,checked_at=$4::timestamptz,
        next_attempt_at=$5::timestamptz,lease_token=NULL,lease_until=NULL,last_error=NULL
        WHERE project_id=$1::uuid AND lease_token=$2::uuid`,
      [projectId, token, page.nextCursor, at, new Date(now + (page.nextCursor ? 0 : SYNC_INTERVAL_MS)).toISOString()]);
    });
    return "synced";
  } catch (error) {
    // An expired/invalid upstream cursor must not strand the backfill forever.
    // Restart safely from the newest page, retaining all already saved posts.
    const restart = source.cursor != null && error instanceof ColosseumApiError
      && error.code === "SOURCE_REJECTED" && error.sourceCode === "BAD_REQUEST";
    await db.query(`UPDATE hq_colosseum_update_sync SET lease_token=NULL,lease_until=NULL,
      next_attempt_at=$3::timestamptz,last_error=$4,cursor=CASE WHEN $5 THEN NULL ELSE cursor END
      WHERE project_id=$1::uuid AND lease_token=$2::uuid`,
    [projectId, token, new Date(now + RETRY_INTERVAL_MS).toISOString(), error instanceof ColosseumApiError ? error.code : "UNAVAILABLE", restart]);
    return "failed";
  }
}

/** Existing imports are discovered every pass, including those initialized
 * before this feature was installed. A bounded pass resumes on the next run. */
export async function syncDueColosseumUpdates(
  db: BuilderDatabase,
  options: SyncOptions & { hackathonId?: number; deadlineMs?: number; limit?: number } = {},
) {
  const now = options.now ?? Date.now();
  const { rows } = await db.query(`SELECT o.project_id::text AS project_id FROM hq_project_onboarding o
    JOIN hq_hackathons h ON h.id=o.hackathon_id AND h.archived_at IS NULL
    LEFT JOIN hq_colosseum_update_sync s ON s.project_id=o.project_id
    WHERE ($2::int IS NULL OR o.hackathon_id=$2)
      AND (s.project_id IS NULL OR (s.next_attempt_at <= $1::timestamptz
        AND (s.lease_until IS NULL OR s.lease_until <= $1::timestamptz)))
    ORDER BY s.checked_at ASC NULLS FIRST,o.project_id LIMIT $3`,
  [new Date(now).toISOString(), options.hackathonId ?? null, Math.max(1, Math.min(50, options.limit ?? 10))]);
  const summary = { synced: 0, failed: 0, skipped: 0, stoppedOnBudget: false };
  const deadline = Math.min(options.deadlineMs ?? Infinity, Date.now() + 20_000);
  for (const row of rows) {
    if (Date.now() + 7_000 > deadline) { summary.stoppedOnBudget = true; break; }
    summary[await syncColosseumUpdates(db, String(row.project_id), { ...options, now })] += 1;
  }
  return summary;
}

/** Check HQ access before fetching anything from the source. Imported history
 * remains separate from authored reports and never changes a closed week. */
export async function readColosseumHistory(
  actor: Actor,
  input: ColosseumHistoryInput,
  db: BuilderDatabase = builderDatabase(),
  options: SyncOptions = {},
): Promise<ColosseumHistoryPage> {
  const decision = await authorizeProjectAction(actor, { ...input, action: "read" }, {
    loadProjectEdition: id => loadProjectEdition(db, id),
    loadTeamMembership: value => loadTeamMembership(db, value),
    loadCapabilities: id => listActiveCapabilities(id, db),
    loadCurrentAssignment: id => loadCurrentAssignment(db, id),
  });
  if (!decision.allowed || actor.kind === "job") return emptyPage();
  const { rows: source } = await db.query("SELECT 1 FROM hq_project_onboarding WHERE project_id=$1::uuid AND hackathon_id=$2", [input.projectId, input.hackathonId]);
  if (!source.length) return emptyPage();
  const cursor = input.cursor?.split("|");
  if (cursor && (cursor.length !== 2 || !Number.isFinite(Date.parse(cursor[0])) || !/^\d{1,16}$/.test(cursor[1]))) return emptyPage();
  await syncColosseumUpdates(db, input.projectId, options);
  const { rows } = await db.query(`SELECT * FROM hq_colosseum_updates WHERE project_id=$1::uuid
    AND ($2::timestamptz IS NULL OR (published_at,external_id) < ($2::timestamptz,$3::bigint))
    ORDER BY published_at DESC,external_id DESC LIMIT 11`, [input.projectId, cursor?.[0] ?? null, cursor?.[1] ?? null]);
  const { rows: sync } = await db.query("SELECT cursor,last_error,lease_token FROM hq_colosseum_update_sync WHERE project_id=$1::uuid", [input.projectId]);
  const updates = rows.slice(0, 10).map(row => ({
    externalId: Number(row.external_id), authorName: String(row.author_name), body: String(row.body),
    links: row.links as string[], sourceUrl: String(row.source_url),
    publishedAt: toIso(row.published_at), updatedAt: toIso(row.source_updated_at),
  }));
  const last = updates.at(-1);
  return { linked: true, updates, nextCursor: rows.length > 10 && last ? `${last.publishedAt}|${last.externalId}` : null,
    syncingOlder: sync[0]?.cursor != null || sync[0]?.lease_token != null, syncFailed: sync[0]?.last_error != null };
}
