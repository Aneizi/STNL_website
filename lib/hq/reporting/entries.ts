import "server-only";
import type { Actor } from "../actor";
import { recordAuditEvent } from "../audit";
import { authorizeProjectAction, canEditEntry, canReadRevisionHistory, entryAudience, type Authorization, type AuthzLoaders } from "../authz-decisions";
import { loadCurrentAssignment, loadProjectEdition, loadTeamMembership, type Entry, type EntryVisibility } from "../authz-sql";
import { atomically, builderDatabase, type BuilderDatabase, type BuilderQuery } from "../builder-db";
import { BuilderError } from "../builder-types";
import { listActiveCapabilities } from "../capabilities";
import { listReportingPeriods, PERIOD_COLUMNS, reportingEligibility, toIso, toPeriod, type ReportingPeriod } from "../reporting-enrolment";
import { periodForInstant } from "../reporting-periods";
import { MAX_BODY_LENGTH, updateCharacterCount } from "../reporting-body";
import { auditActor, isUuidArg } from "./shared";

/** Bind decisions to the active transaction so authorization observes its writes. */
function loadersOver(db: BuilderQuery): AuthzLoaders {
  return {
    loadProjectEdition: (projectId) => loadProjectEdition(db, projectId),
    loadTeamMembership: (input) => loadTeamMembership(db, input),
    loadCapabilities: (userId) => listActiveCapabilities(userId, db),
    loadCurrentAssignment: (projectId) => loadCurrentAssignment(db, projectId),
  };
}

export type ReportingEntrySource = "hq" | "telegram";

/** Authorized list shape: current text only, never revision bodies or author ids. */
export type ReportingEntryView = {
  id: string;
  projectId: string;
  periodId: string;
  periodSequence: number;
  body: string;
  visibility: EntryVisibility;
  source: ReportingEntrySource;
  version: number;
  /** An entry deliberately added to a period that had already passed. It never changes that period's recorded outcome. */
  late: boolean;
  /** An edited indication without exposing prior versions. */
  edited: boolean;
  submittedAt: string;
  updatedAt: string;
  authorName: string;
  /** Whether the viewer wrote it. No author id is included, so a list cannot be joined back to an account. */
  authorIsYou: boolean;
  canEdit: boolean;
  /** Admin moderation. A member reader never receives a voided entry at all, so this is only ever true for an operator. */
  voided: boolean;
};

type EntryRow = Record<string, unknown>;

const ENTRY_SELECT = `
  SELECT e.id::text AS id, e.project_id::text AS project_id, e.period_id::text AS period_id, pr.sequence AS period_sequence,
         e.body, e.visibility, e.source, e.version, e.late, e.submitted_at, e.updated_at,
         e.author_kind, e.author_id, e.voided_at,
         COALESCE(b.name, u.display_name, 'Removed account') AS author_name
  FROM hq_reporting_entries e
  JOIN hq_reporting_periods pr ON pr.id = e.period_id
  LEFT JOIN hq_builder_profiles b ON e.author_kind = 'member' AND b.id = e.author_id
  LEFT JOIN hq_users u ON e.author_kind = 'operator' AND u.id::text = e.author_id`;

/** The author key as authz-sql composes it, so a view and a decision agree on who "you" is. */
const authorKey = (row: EntryRow) => (row.author_kind === "operator" ? `operator:${String(row.author_id)}` : String(row.author_id));

function toEntryView(row: EntryRow, viewer: Actor, canEdit: boolean): ReportingEntryView {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    periodId: String(row.period_id),
    periodSequence: Number(row.period_sequence),
    body: String(row.body),
    visibility: row.visibility === "sensitive" ? "sensitive" : "shared",
    source: row.source === "telegram" ? "telegram" : "hq",
    version: Number(row.version),
    late: Boolean(row.late),
    edited: Number(row.version) > 1,
    submittedAt: toIso(row.submitted_at),
    updatedAt: toIso(row.updated_at),
    authorName: String(row.author_name),
    authorIsYou: viewer.kind !== "job" && authorKey(row) === (viewer.kind === "operator" ? `operator:${viewer.id}` : viewer.id),
    canEdit: canEdit && row.voided_at == null,
    voided: row.voided_at != null,
  };
}

/** The entry as `loadEntry` sees it, without a second query: the same fields, from a row this module already has. */
const toEntryFact = (row: EntryRow, hackathonId: number): Entry => ({
  id: String(row.id),
  projectId: String(row.project_id),
  hackathonId,
  authorUserId: authorKey(row),
  visibility: row.visibility === "sensitive" ? "sensitive" : "shared",
});

/** Who is writing, in the two columns `hq_reporting_entries` and its revisions record. A job never authors an entry. */
function writerColumns(actor: Actor): { kind: "member" | "operator"; id: string } {
  if (actor.kind === "job") throw new BuilderError("A background job cannot author a reporting entry.");
  return { kind: actor.kind === "operator" ? "operator" : "member", id: actor.id };
}

type BodyProblem = "empty_body" | "body_too_long";

/** The one body rule, applied identically on create and on edit. Returns the trimmed text or the problem with it. */
function checkBody(raw: string): { body: string } | { problem: BodyProblem } {
  const body = String(raw ?? "").trim();
  if (!body) return { problem: "empty_body" };
  if (updateCharacterCount(body) > MAX_BODY_LENGTH) return { problem: "body_too_long" };
  return { body };
}

/**
 * Team membership takes precedence over Captain capability. A Captain writing
 * for their own team cannot hide an update from their teammates.
 */
const mayWriteSensitive = (decision: Authorization) => decision.allowed && (decision.via === "operator" || decision.via === "captain");

export type CreateUpdateInput = {
  projectId: string;
  hackathonId: number;
  body: string;
  visibility?: EntryVisibility;
  source?: ReportingEntrySource;
  /**
   * The period the caller's draft was bound to. When it is no longer the open
   * one — a save that crossed midnight — the save is refused with the period
   * that is open now, so the caller can ask before moving the text into a
   * different week.
   */
  expectedPeriodId?: string;
  /** An explicitly chosen period, for a late entry against a week that has passed. */
  periodId?: string;
  /** Server clock injection for tests. Web actions and bot payloads never accept this field. */
  atMs?: number;
};

export type CreateUpdateRefusal =
  | "not_authorized" | "empty_body" | "body_too_long" | "not_eligible"
  | "no_open_period" | "period_not_found" | "period_changed" | "visibility_not_allowed";

export type CreateUpdateResult =
  | { ok: true; entry: ReportingEntryView; period: ReportingPeriod; completesPeriod: boolean }
  | { ok: false; reason: CreateUpdateRefusal; currentPeriod?: ReportingPeriod | null };

/**
 * Shared write path for HQ and Telegram. Only an on-time entry written through
 * team membership counts toward completion; Captain/operator notes never do.
 * Late entries preserve the closed period's outcome. The saved timestamp and
 * period are derived from the same server clock inside the transaction.
 */
export async function createUpdate(
  actor: Actor,
  input: CreateUpdateInput,
  db: BuilderDatabase | BuilderQuery = builderDatabase(),
): Promise<CreateUpdateResult> {
  const checked = checkBody(input.body);
  if ("problem" in checked) return { ok: false, reason: checked.problem };
  const visibility: EntryVisibility = input.visibility === "sensitive" ? "sensitive" : "shared";
  const atMs = input.atMs ?? Date.now();
  const writer = writerColumns(actor);
  return atomically(db, async (tx) => {
    const loaders = loadersOver(tx);
    const projectEdition = await loadProjectEdition(tx, input.projectId);
    if (!projectEdition || projectEdition.hackathonId !== input.hackathonId) return { ok: false, reason: "not_authorized" };
    const decision = await authorizeProjectAction(actor, { projectId: input.projectId, hackathonId: input.hackathonId, action: "update.create" }, loaders);
    if (!decision.allowed) return { ok: false, reason: "not_authorized" };
    if (visibility === "sensitive" && !mayWriteSensitive(decision)) return { ok: false, reason: "visibility_not_allowed" };
    const eligibility = await reportingEligibility(tx, input.projectId);
    if (!eligibility) return { ok: false, reason: "not_eligible" };
    const periods = await listReportingPeriods(tx, input.hackathonId);
    const open = periodForInstant(periods, atMs);
    const period = input.periodId ? periods.find((candidate) => candidate.id === input.periodId) : open;
    if (input.periodId && !period) return { ok: false, reason: "period_not_found" };
    if (!period) return { ok: false, reason: "no_open_period" };
    // Only an implicit save is bound to the open period; a caller explicitly
    // choosing an older week has already answered the question this asks.
    if (!input.periodId && input.expectedPeriodId && input.expectedPeriodId !== period.id) {
      return { ok: false, reason: "period_changed", currentPeriod: open };
    }
    // Serialize against schedule reconciliation's FOR UPDATE lock so a period
    // cannot be deleted as empty while this transaction inserts an entry into it.
    const { rows: locked } = await tx.query(
      `SELECT ${PERIOD_COLUMNS} FROM hq_reporting_periods WHERE id = $1::uuid FOR SHARE`,
      [period.id],
    );
    if (!locked.length) return { ok: false, reason: "period_not_found" };
    const current = toPeriod(locked[0]);
    // A lock wait can cross the boundary or follow a schedule change. Decide
    // against the locked row and the actual save instant, then store that
    // same instant so completion and history cannot disagree.
    const savedAtMs = input.atMs ?? Date.now();
    if (savedAtMs < Date.parse(current.startsAt)) return { ok: false, reason: "no_open_period" };
    const late = current.closedAt != null || savedAtMs >= Date.parse(current.endsAt);
    if (late && !input.periodId) {
      return { ok: false, reason: "period_changed", currentPeriod: periodForInstant(await listReportingPeriods(tx, input.hackathonId), savedAtMs) };
    }
    // A week that ended before the team joined reporting still takes a late
    // update: a team that imports after the fact can backfill its history.
    // Late entries never count, so the week stays exempt rather than completed.
    // Read straight off the decision: `via: "member"` is the team writing
    // for itself, anything else is a note about the team.
    const countsTowardCompletion = decision.via === "member";
    const { rows } = await tx.query(
      `INSERT INTO hq_reporting_entries (project_id, period_id, author_kind, author_id, body, visibility, source, late, submitted_at, counts_toward_completion)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10) RETURNING id::text AS id`,
      [input.projectId, period.id, writer.kind, writer.id, checked.body, visibility, input.source === "telegram" ? "telegram" : "hq", late, new Date(savedAtMs).toISOString(), countsTowardCompletion],
    );
    const entryId = String(rows[0].id);
    await appendRevision(tx, { entryId, version: 1, body: checked.body, visibility, editor: writer });
    const entry = await readEntryView(tx, entryId, actor, loaders, true);
    if (!entry) return { ok: false, reason: "not_authorized" };
    return { ok: true, entry, period: current, completesPeriod: countsTowardCompletion && !late && current.closedAt == null };
  });
}

/** The append-only half of every write. Called inside the caller's transaction, never on its own. */
async function appendRevision(
  tx: BuilderQuery,
  input: { entryId: string; version: number; body: string; visibility: EntryVisibility; editor: { kind: "member" | "operator"; id: string } },
): Promise<void> {
  await tx.query(
    `INSERT INTO hq_reporting_entry_revisions (entry_id, version, body, visibility, editor_kind, editor_id)
     VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
    [input.entryId, input.version, input.body, input.visibility, input.editor.kind, input.editor.id],
  );
}

/** One entry as this viewer may see it, or null when they may not. `canEdit` is passed in where the caller already decided it. */
async function readEntryView(db: BuilderQuery, entryId: string, viewer: Actor, loaders: AuthzLoaders, canEdit?: boolean): Promise<ReportingEntryView | null> {
  const { rows } = await db.query(`${ENTRY_SELECT} WHERE e.id = $1::uuid`, [entryId]);
  if (!rows.length) return null;
  const row = rows[0];
  const { rows: edition } = await db.query("SELECT hackathon_id FROM hq_projects WHERE id = $1::uuid", [String(row.project_id)]);
  if (!edition.length) return null;
  const fact = toEntryFact(row, Number(edition[0].hackathon_id));
  const audience = await entryAudience(fact, viewer, loaders);
  if (audience === "none") return null;
  return toEntryView(row, viewer, canEdit ?? audience === "read_write");
}

export type EditUpdateInput = {
  entryId: string;
  body?: string;
  visibility?: EntryVisibility;
  /** The version the caller last read. A mismatch is a conflict, never a silent overwrite. */
  expectedVersion: number;
  /** Required to move a sensitive note back to shared, so the new audience is an explicit choice. */
  confirmAudienceChange?: boolean;
};

export type EditUpdateRefusal =
  | "not_found" | "not_authorized" | "empty_body" | "body_too_long"
  | "conflict" | "voided" | "visibility_not_allowed" | "audience_not_confirmed";

export type EditUpdateResult =
  | { ok: true; entry: ReportingEntryView; changed: boolean }
  | { ok: false; reason: EditUpdateRefusal; current?: ReportingEntryView };

/**
 * The authorized author or an operator may edit. Lock and compare versions to
 * preserve concurrent drafts. Author, submission time and period never change.
 * Sharing a sensitive note requires confirmation; prior revisions stay private.
 */
export async function editUpdate(
  actor: Actor,
  input: EditUpdateInput,
  db: BuilderDatabase | BuilderQuery = builderDatabase(),
): Promise<EditUpdateResult> {
  if (!isUuidArg(input.entryId)) return { ok: false, reason: "not_found" };
  const checked = input.body === undefined ? null : checkBody(input.body);
  if (checked && "problem" in checked) return { ok: false, reason: checked.problem };
  return atomically(db, async (tx) => {
    const { rows } = await tx.query(`${ENTRY_SELECT} WHERE e.id = $1::uuid FOR UPDATE OF e`, [input.entryId]);
    if (!rows.length) return { ok: false, reason: "not_found" };
    const row = rows[0];
    const { rows: edition } = await tx.query("SELECT hackathon_id FROM hq_projects WHERE id = $1::uuid", [String(row.project_id)]);
    if (!edition.length) return { ok: false, reason: "not_found" };
    const hackathonId = Number(edition[0].hackathon_id);
    const loaders = loadersOver(tx);
    const fact = toEntryFact(row, hackathonId);
    if (!(await canEditEntry(actor, fact, loaders))) return { ok: false, reason: "not_authorized" };
    if (row.voided_at != null) return { ok: false, reason: "voided" };

    const current = toEntryView(row, actor, true);
    if (current.version !== input.expectedVersion) return { ok: false, reason: "conflict", current };

    const body = checked ? checked.body : current.body;
    const visibility: EntryVisibility = input.visibility ?? current.visibility;
    if (visibility === current.visibility && body === current.body) return { ok: true, entry: current, changed: false };
    if (visibility !== current.visibility) {
      const decision = await authorizeProjectAction(actor, { projectId: current.projectId, hackathonId, action: "update.edit" }, loaders);
      if (!mayWriteSensitive(decision)) return { ok: false, reason: "visibility_not_allowed" };
      if (visibility === "shared" && !input.confirmAudienceChange) return { ok: false, reason: "audience_not_confirmed" };
    }

    const writer = writerColumns(actor);
    const version = current.version + 1;
    const { rows: updated } = await tx.query(
      `UPDATE hq_reporting_entries SET body=$2, visibility=$3, version=$4, updated_at=now()
       WHERE id=$1::uuid AND version=$5 RETURNING id::text AS id`,
      [input.entryId, body, visibility, version, current.version],
    );
    // The lock above already settled this, so a lost race here means the row
    // moved under a handle that is not a real transaction; refusing is still
    // the only safe answer.
    if (!updated.length) return { ok: false, reason: "conflict", current };
    await appendRevision(tx, { entryId: input.entryId, version, body, visibility, editor: writer });
    const entry = await readEntryView(tx, input.entryId, actor, loaders, true);
    return entry ? { ok: true, entry, changed: true } : { ok: false, reason: "not_found" };
  });
}

export type VoidUpdateResult = { ok: true; entry: ReportingEntryView } | { ok: false; reason: "not_found" | "not_authorized" | "already_voided" };

/**
 * Operator moderation preserves the entry and its revisions but stops it counting
 * toward completion. Audit only the reason and ids, never the entry body.
 */
export async function voidUpdate(
  actor: Actor,
  input: { entryId: string; reason: string },
  db: BuilderDatabase | BuilderQuery = builderDatabase(),
): Promise<VoidUpdateResult> {
  if (actor.kind !== "operator") return { ok: false, reason: "not_authorized" };
  if (!isUuidArg(input.entryId)) return { ok: false, reason: "not_found" };
  return atomically(db, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE hq_reporting_entries SET voided_at=now(), voided_by_user_id=$2::uuid, void_reason=$3
       WHERE id=$1::uuid AND voided_at IS NULL RETURNING id::text AS id, project_id::text AS project_id, period_id::text AS period_id`,
      [input.entryId, actor.id, input.reason],
    );
    if (!rows.length) {
      const { rows: existing } = await tx.query("SELECT voided_at FROM hq_reporting_entries WHERE id=$1::uuid", [input.entryId]);
      return { ok: false, reason: existing.length ? "already_voided" : "not_found" };
    }
    const { rows: edition } = await tx.query("SELECT hackathon_id FROM hq_projects WHERE id=$1::uuid", [String(rows[0].project_id)]);
    await recordAuditEvent(tx, {
      kind: "reporting.entry_voided",
      actor: auditActor(actor),
      hackathonId: edition.length ? Number(edition[0].hackathon_id) : null,
      projectId: String(rows[0].project_id),
      metadata: { entryId: String(rows[0].id), periodId: String(rows[0].period_id), reason: input.reason },
    });
    const entry = await readEntryView(tx, String(rows[0].id), actor, loadersOver(tx), true);
    return entry ? { ok: true, entry } : { ok: false, reason: "not_found" };
  });
}

export type ReadUpdatesInput = {
  projectId: string;
  hackathonId: number;
  periodId?: string;
  entryId?: string;
  limit?: number;
  /** The `nextCursor` of the previous page. */
  cursor?: string;
};

export type ReportingEntryPage = { entries: ReportingEntryView[]; nextCursor: string | null };

const DEFAULT_PAGE = 25;
const MAX_PAGE = 100;

function entryCursor(value: string): [string, string] | null {
  const [at, id, extra] = value.split("|");
  return extra === undefined && isUuidArg(id) && Number.isFinite(Date.parse(at)) ? [at, id] : null;
}

/**
 * Apply the audience in SQL: members never load others' sensitive notes or
 * voided entries. A denial is an empty page, revealing no project information.
 * Keyset pagination uses (submitted_at, id); revisions are never joined.
 */
export async function readAuthorizedUpdates(
  actor: Actor,
  input: ReadUpdatesInput,
  db: BuilderQuery = builderDatabase(),
): Promise<ReportingEntryPage> {
  if (input.entryId && !isUuidArg(input.entryId)) return { entries: [], nextCursor: null };
  if (input.periodId && !isUuidArg(input.periodId)) return { entries: [], nextCursor: null };
  const cursor = input.cursor ? entryCursor(input.cursor) : null;
  if (input.cursor && !cursor) return { entries: [], nextCursor: null };
  const decision = await authorizeProjectAction(actor, { projectId: input.projectId, hackathonId: input.hackathonId, action: "read" }, loadersOver(db));
  if (!decision.allowed || actor.kind === "job") return { entries: [], nextCursor: null };
  const limit = Math.max(1, Math.min(MAX_PAGE, Math.floor(input.limit ?? DEFAULT_PAGE)));
  const values: unknown[] = [input.projectId];
  const where = ["e.project_id = $1::uuid"];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  if (actor.kind !== "operator") {
    // A member reads shared entries, plus sensitive ones they wrote
    // themselves; a voided entry is not theirs to see either way.
    where.push(`e.voided_at IS NULL`, `(e.visibility = 'shared' OR (e.author_kind = 'member' AND e.author_id = ${bind(actor.id)}))`);
  }
  if (input.periodId) where.push(`e.period_id = ${bind(input.periodId)}::uuid`);
  if (input.entryId) where.push(`e.id = ${bind(input.entryId)}::uuid`);
  if (cursor) {
    const [at, id] = cursor;
    where.push(`(e.submitted_at, e.id) < (${bind(at)}::timestamptz, ${bind(id)}::uuid)`);
  }
  const { rows } = await db.query(
    `${ENTRY_SELECT} WHERE ${where.join(" AND ")} ORDER BY e.submitted_at DESC, e.id DESC LIMIT ${bind(limit + 1)}`,
    values,
  );
  const page = rows.slice(0, limit);
  // Every row here is already readable by this actor; what is left to decide
  // is who may change it. An operator may edit any entry, a member only their
  // own, and nobody edits a voided one.
  const entries = page.map((row) => toEntryView(row, actor, actor.kind === "operator" || (row.voided_at == null && authorKey(row) === actor.id)));
  const last = page[page.length - 1];
  return { entries, nextCursor: rows.length > limit && last ? `${toIso(last.submitted_at)}|${String(last.id)}` : null };
}

/** First pages for a Captain board in one bounded read per project.
 * Current assignment, live capability and the note audience are checked in
 * the same SQL statement. The lateral limit applies before author/profile
 * data leaves the server; history and other authors' sensitive notes are
 * never selected. Later pages still use readAuthorizedUpdates.
 */
export async function readCaptainUpdatePages(
  actor: Actor,
  input: { hackathonId: number; projectIds: readonly string[]; limit?: number },
  db: BuilderQuery = builderDatabase(),
): Promise<Map<string, ReportingEntryPage>> {
  const pages = new Map<string, ReportingEntryPage>();
  const ids = [...new Set(input.projectIds)].filter(isUuidArg);
  if (actor.kind !== "member" || !ids.length) return pages;
  const limit = Math.max(1, Math.min(MAX_PAGE, Math.floor(input.limit ?? DEFAULT_PAGE)));
  const { rows } = await db.query(
    `SELECT page.* FROM hq_projects p
     JOIN LATERAL (
       ${ENTRY_SELECT}
       WHERE e.project_id = p.id AND e.voided_at IS NULL
         AND (e.visibility = 'shared' OR (e.author_kind = 'member' AND e.author_id = $3))
       ORDER BY e.submitted_at DESC, e.id DESC LIMIT $4
     ) page ON true
     WHERE p.hackathon_id = $1 AND p.id = ANY($2::uuid[])
       AND EXISTS (SELECT 1 FROM hq_captain_assignments a WHERE a.project_id = p.id
         AND a.captain_user_id = $3 AND a.unassigned_at IS NULL)
       AND EXISTS (SELECT 1 FROM hq_account_capabilities c WHERE c.user_id = $3
         AND c.capability = 'captain' AND c.revoked_at IS NULL)
     ORDER BY page.project_id, page.submitted_at DESC, page.id DESC`,
    [input.hackathonId, ids, actor.id, limit + 1],
  );
  for (const row of rows) {
    const projectId = String(row.project_id);
    const page = pages.get(projectId) ?? { entries: [], nextCursor: null };
    if (page.entries.length < limit) {
      page.entries.push(toEntryView(row, actor, authorKey(row) === actor.id));
    } else {
      const last = page.entries.at(-1)!;
      page.nextCursor = `${last.submittedAt}|${last.id}`;
    }
    pages.set(projectId, page);
  }
  return pages;
}

/** One of the caller's own updates, with the project it belongs to so a list of them reads as something other than loose text. */
export type OwnReportingEntry = ReportingEntryView & { projectName: string };

export type OwnReportingEntryPage = { entries: OwnReportingEntry[]; nextCursor: string | null };

/**
 * Current Captains may read only their own non-voided entries in this edition,
 * including notes on formerly assigned teams. These are always read-only and
 * confer no access to other team records. Keyset paged without revision bodies.
 */
export async function readOwnUpdates(
  actor: Actor,
  input: { hackathonId: number; limit?: number; cursor?: string; entryId?: string },
  db: BuilderQuery = builderDatabase(),
): Promise<OwnReportingEntryPage> {
  if (actor.kind !== "member") return { entries: [], nextCursor: null };
  if (input.entryId && !isUuidArg(input.entryId)) return { entries: [], nextCursor: null };
  const cursor = input.cursor ? entryCursor(input.cursor) : null;
  if (input.cursor && !cursor) return { entries: [], nextCursor: null };
  if (!(await listActiveCapabilities(actor.id, db)).includes("captain")) return { entries: [], nextCursor: null };
  const limit = Math.max(1, Math.min(MAX_PAGE, Math.floor(input.limit ?? DEFAULT_PAGE)));
  const values: unknown[] = [input.hackathonId, actor.id];
  // `pr` is the period ENTRY_SELECT already joins, and it carries the
  // edition: no second join, and no project read inside the page.
  const where = ["pr.hackathon_id = $1", "e.author_kind = 'member'", "e.author_id = $2", "e.voided_at IS NULL"];
  if (input.entryId) {
    values.push(input.entryId);
    where.push(`e.id = $${values.length}::uuid`);
  }
  if (cursor) {
    const [at, id] = cursor;
    values.push(at, id);
    where.push(`(e.submitted_at, e.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
  }
  values.push(limit + 1);
  const { rows } = await db.query(
    `WITH own AS (
       ${ENTRY_SELECT} WHERE ${where.join(" AND ")} ORDER BY e.submitted_at DESC, e.id DESC LIMIT $${values.length}
     )
     SELECT own.*, p.name AS own_project_name FROM own JOIN hq_projects p ON p.id::text = own.project_id
     ORDER BY own.submitted_at DESC, own.id DESC`,
    values,
  );
  const page = rows.slice(0, limit);
  const entries = page.map((row) => ({ ...toEntryView(row, actor, false), projectName: String(row.own_project_name) }));
  const last = page[page.length - 1];
  return { entries, nextCursor: rows.length > limit && last ? `${toIso(last.submitted_at)}|${String(last.id)}` : null };
}

export type ReportingRevision = {
  entryId: string;
  version: number;
  body: string;
  visibility: EntryVisibility;
  editorKind: "member" | "operator";
  editorId: string;
  editorName: string;
  createdAt: string;
};

/**
 * Operator-only history, paged by version. All other actors receive an empty list,
 * including authors, so the response cannot reveal an entry's existence.
 */
export async function readRevisionHistory(
  actor: Actor,
  input: { entryId: string; limit?: number; afterVersion?: number },
  db: BuilderQuery = builderDatabase(),
): Promise<ReportingRevision[]> {
  if (!canReadRevisionHistory(actor) || !isUuidArg(input.entryId)) return [];
  const limit = Math.max(1, Math.min(MAX_PAGE, Math.floor(input.limit ?? MAX_PAGE)));
  const { rows } = await db.query(
    `SELECT r.entry_id::text AS entry_id, r.version, r.body, r.visibility, r.editor_kind, r.editor_id, r.created_at,
            COALESCE(b.name, u.display_name, 'Removed account') AS editor_name
     FROM hq_reporting_entry_revisions r
     LEFT JOIN hq_builder_profiles b ON r.editor_kind = 'member' AND b.id = r.editor_id
     LEFT JOIN hq_users u ON r.editor_kind = 'operator' AND u.id::text = r.editor_id
     WHERE r.entry_id = $1::uuid AND r.version > $2 ORDER BY r.version LIMIT $3`,
    [input.entryId, Math.max(0, Math.floor(input.afterVersion ?? 0)), limit],
  );
  return rows.map((row) => ({
    entryId: String(row.entry_id),
    version: Number(row.version),
    body: String(row.body),
    visibility: row.visibility === "sensitive" ? "sensitive" : "shared",
    editorKind: row.editor_kind === "operator" ? "operator" : "member",
    editorId: String(row.editor_id),
    editorName: String(row.editor_name),
    createdAt: toIso(row.created_at),
  }));
}
