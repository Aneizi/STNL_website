import "server-only";
import type { Actor } from "./actor";
import { recordAuditEvent, type AuditActor } from "./audit";
import { authorizeProjectAction, canEditEntry, canReadRevisionHistory, entryAudience, type Authorization, type AuthzLoaders } from "./authz-decisions";
import { loadCurrentAssignment, loadProjectEdition, loadTeamMembership, type Entry, type EntryVisibility } from "./authz-sql";
import { atomically, builderDatabase, type BuilderDatabase, type BuilderQuery } from "./builder-db";
import { BuilderError } from "./builder-types";
import { listActiveCapabilities } from "./capabilities";
import {
  listReportingEligibility,
  listReportingPeriods,
  PERIOD_COLUMNS,
  reportingEligibility,
  toIso,
  toPeriod,
  type ReportingEligibility,
  type ReportingPeriod,
} from "./reporting-enrolment";
import { periodForInstant, type ReportingPeriodMode } from "./reporting-periods";

/**
 * The reporting service (contracts.md's "Reporting service" row): the one
 * place periods, eligibility, entries, revisions, completion and outcomes are
 * written, shared by the web actions today and the Telegram bot in phase 7.
 * Web actions and bot handlers stay thin callers; every rule below is
 * enforced here, on the server, over facts read in the same transaction.
 *
 * Where each thing lives:
 *
 * - The schedule arithmetic is pure and lives in ./reporting-periods, so the
 *   plan's period table can be asserted literally without a database.
 * - Every project decision goes through `authorizeProjectAction`, and an
 *   entry's audience through `entryAudience`/`canEditEntry` over `loadEntry`:
 *   the phase 1 decisions, unchanged, and there is no second per-action
 *   permission rule here. They are imported from ./authz-decisions rather
 *   than ./authz because ./authz's own `requireOperator()` reaches the public
 *   member auth graph, and phase 6's operator Server Actions call this module
 *   (tests/hq/operator-imports.test.ts). Same decisions, same definitions;
 *   ./authz re-exports every one of them for everybody else.
 * - The tables are documented where they are created, in
 *   scripts/hq/builder-schema.sql. Read those comment blocks before changing
 *   anything here.
 *
 * Reporting is keyed on `hq_projects`, never on `hq_project_onboarding`. A
 * project an admin created directly in the CRM, with no imported team behind
 * it, therefore has exactly the same reporting record as an imported one once
 * an admin enables it: the same eligibility row, the same periods, the same
 * status, and a name to show. That is the deliberate answer to the reduced
 * card `/hq/captain` falls back to for such a project (contracts.md's "A
 * known UX gap phase 5 will meet again"): what that project lacks is roster
 * and Colosseum detail, which reporting never needed, so a reporting surface
 * has nothing reduced about it. `imported` is carried on the eligibility and
 * status shapes so a caller that also wants to show team detail knows in
 * advance whether there is any.
 */

/** Who an audit event records. A background job has no id of its own, and writes as `system`. */
const auditActor = (actor: Actor): AuditActor =>
  actor.kind === "job" ? { kind: "system", id: null } : { kind: actor.kind, id: actor.id };

/**
 * The authorization loaders bound to one query handle.
 *
 * Every decision this module makes inside a transaction passes these, rather
 * than letting ./authz build its own handle from the pool: a decision read on
 * a second connection would see the pre-transaction state, and on a
 * single-connection handle it would simply wait for a transaction that is
 * waiting for it. Passing the handle also makes each decision read the rows
 * this transaction has already written, which is what "authorize over facts
 * read in the same transaction" means in practice.
 */
function loadersOver(db: BuilderQuery): AuthzLoaders {
  return {
    loadProjectEdition: (projectId) => loadProjectEdition(db, projectId),
    loadTeamMembership: (input) => loadTeamMembership(db, input),
    loadCapabilities: (userId) => listActiveCapabilities(userId, db),
    loadCurrentAssignment: (projectId) => loadCurrentAssignment(db, projectId),
  };
}

/**
 * The schedule and eligibility half of the service. It lives in
 * ./reporting-enrolment so that the store can enrol a team inside the
 * import's own transaction without this module's `./authz` import closing a
 * cycle; a caller should not have to know that, so everything it owns is part
 * of this module's surface.
 */
export {
  currentReportingPeriod,
  enableReporting,
  ensureReportingPeriods,
  listReportingEligibility,
  listReportingPeriods,
  pauseReporting,
  // The period row's own column list and its two readers, so a caller that
  // selects a period itself (phase 8's job runner does, to find the weeks
  // whose nudge or end has passed) reads it through the same three
  // definitions this module does rather than restating the columns.
  PERIOD_COLUMNS,
  periodColumns,
  previewReportingPeriods,
  readReportingConfig,
  readReportingSchedule,
  reportingEligibility,
  toDay,
  toIso,
  toPeriod,
  writeReportingConfig,
} from "./reporting-enrolment";
export type {
  ReportingConfig,
  ReportingEligibility,
  ReportingEligibilityResult,
  ReportingPeriod,
  ReportingPause,
  ReportingPeriodConflict,
  ReportingPeriodConflictReason,
  ReportingPeriodPlan,
  ReportingScheduleProblem,
} from "./reporting-enrolment";
export type { GeneratedPeriod, ReportingPeriodMode, ReportingSchedule } from "./reporting-periods";

/** The builder-side pool, so a caller can reach the service without building a handle of its own. */
export const reportingDatabase = builderDatabase;

/**
 * The plan's plain-text update: one field, 4,000 characters. A constant here
 * rather than configuration, because the same number is the CHECK constraint
 * on `hq_reporting_entries.body`, and two places to change it would mean a
 * save the application accepts and the database refuses.
 */
export const MAX_BODY_LENGTH = 4000;

export type ReportingEntrySource = "hq" | "telegram";

/**
 * One reporting entry as an authorized reader may see it. There is no
 * revision field and no revision count: history is operator-only and is read
 * on demand through `readRevisionHistory`, so a list response never carries a
 * prior version's bytes at all (the plan's "Normal list queries never join or
 * serialize revision bodies").
 */
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
  /** The plan's "simple edited indication": that it changed, never what it said before. */
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

/** The author key as ./authz-sql composes it, so a view and a decision agree on who "you" is. */
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
    canEdit,
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
  if (body.length > MAX_BODY_LENGTH) return { problem: "body_too_long" };
  return { body };
}

/**
 * Whether this actor may mark an entry on this project sensitive.
 *
 * `via: "captain"` is exactly "the project's current Captain, and not one of
 * its team members": `authorizeProjectAction` checks membership first, so an
 * account that is a Captain elsewhere but posting as a member of its own team
 * comes back as `via: "member"` and cannot use the global capability to hide
 * an update from its own teammates. That is the plan's rule, read straight
 * off the decision rather than re-derived here.
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
  /** The instant the save happens at. Defaults to now; a caller never supplies the stored timestamp, only which period to resolve. */
  atMs?: number;
};

export type CreateUpdateRefusal =
  | "not_authorized" | "empty_body" | "body_too_long" | "not_eligible"
  | "no_open_period" | "period_not_found" | "period_changed" | "visibility_not_allowed";

export type CreateUpdateResult =
  | { ok: true; entry: ReportingEntryView; period: ReportingPeriod; completesPeriod: boolean }
  | { ok: false; reason: CreateUpdateRefusal; currentPeriod?: ReportingPeriod | null };

/**
 * Adds a reporting entry. The single write path for the website today and the
 * Telegram bot in phase 7: `source` says which, and nothing else differs.
 *
 * What completes a week is the existence of a qualifying entry in the period,
 * not this call: `completesPeriod` is a statement about the period after the
 * save, and a second entry in an already-complete week returns true without
 * creating a second completion event. An entry saved against a period that
 * has passed is marked `late` and completes nothing — the plan's "a late
 * entry must not silently erase a missed week".
 *
 * The body, the period and the author all come from the server: the trimmed
 * text, the period resolved from the instant (or explicitly chosen), and
 * `submitted_at` from the database's own clock.
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
    // The chosen period, locked for the rest of this transaction before a row
    // is written against it. `ensureReportingPeriods` holds FOR UPDATE on
    // every period of an edition while it reconciles the schedule, so this
    // either waits for that reconciliation and then finds the row gone (the
    // save is refused, and the text is still in the composer) or holds the
    // row and makes the reconciliation wait, which then counts this entry and
    // leaves the week exactly where it is. Without it the entry is inserted
    // against a period a concurrent delete has already decided is empty, and
    // the cascade takes the entry and its revisions with the period.
    const { rows: locked } = await tx.query(
      `SELECT ${PERIOD_COLUMNS} FROM hq_reporting_periods WHERE id = $1::uuid FOR SHARE`,
      [period.id],
    );
    if (!locked.length) return { ok: false, reason: "period_not_found" };
    const current = toPeriod(locked[0]);
    const late = current.closedAt != null || atMs >= Date.parse(current.endsAt);
    const { rows } = await tx.query(
      `INSERT INTO hq_reporting_entries (project_id, period_id, author_kind, author_id, body, visibility, source, late)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8) RETURNING id::text AS id`,
      [input.projectId, period.id, writer.kind, writer.id, checked.body, visibility, input.source === "telegram" ? "telegram" : "hq", late],
    );
    const entryId = String(rows[0].id);
    await appendRevision(tx, { entryId, version: 1, body: checked.body, visibility, editor: writer });
    const entry = await readEntryView(tx, entryId, actor, loaders, true);
    if (!entry) return { ok: false, reason: "not_authorized" };
    return { ok: true, entry, period: current, completesPeriod: !late && current.closedAt == null };
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
 * Edits an existing entry: the author while they are still authorized on the
 * project, or an operator moderating.
 *
 * The original author, the original `submitted_at` and the entry's period are
 * all left exactly as they were, so an edit is a correction to a week's
 * record and never a new week's completion. `expectedVersion` is checked
 * against the row under a lock; a mismatch returns the current entry so the
 * caller can keep the text the person had not saved yet rather than throwing
 * it away — the case the plan names for HQ and Telegram editing at once.
 *
 * Making a sensitive note shared needs `confirmAudienceChange`. Only the
 * current version becomes shared: prior revisions stay where they always
 * were, readable by operators alone, which is why nothing here rewrites them.
 */
export async function editUpdate(
  actor: Actor,
  input: EditUpdateInput,
  db: BuilderDatabase | BuilderQuery = builderDatabase(),
): Promise<EditUpdateResult> {
  const checked = input.body === undefined ? null : checkBody(input.body);
  if (checked && "problem" in checked) return { ok: false, reason: checked.problem };
  return atomically(db, async (tx) => {
    const { rows } = await tx.query(`${ENTRY_SELECT} WHERE e.id = $1::uuid FOR UPDATE OF e`, [input.entryId].filter(isUuidArg));
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

/** `FOR UPDATE` on a non-uuid would error rather than miss; the id is filtered to a uuid first, exactly as the loaders do. */
const UUID_ARG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuidArg = (value: unknown): value is string => typeof value === "string" && UUID_ARG.test(value);

export type VoidUpdateResult = { ok: true; entry: ReportingEntryView } | { ok: false; reason: "not_found" | "not_authorized" | "already_voided" };

/**
 * Admin moderation: an entry stops counting toward completion without being
 * deleted, and its revisions are untouched. Ordinary permissions offer no
 * delete at all, here or anywhere else in this module, which is how the
 * plan's "prevent production hard deletion of revisions through ordinary app
 * permissions" is met.
 *
 * The audit event records the reason and the ids, never the body: an audit
 * log operators read in bulk is the wrong home for a team's or a Captain's
 * text, and a voided sensitive note would otherwise leak into it.
 */
export async function voidUpdate(
  actor: Actor,
  input: { entryId: string; reason: string },
  db: BuilderDatabase | BuilderQuery = builderDatabase(),
): Promise<VoidUpdateResult> {
  if (actor.kind !== "operator") return { ok: false, reason: "not_authorized" };
  return atomically(db, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE hq_reporting_entries SET voided_at=now(), voided_by_user_id=$2::uuid, void_reason=$3
       WHERE id=$1::uuid AND voided_at IS NULL RETURNING id::text AS id, project_id::text AS project_id, period_id::text AS period_id`,
      [input.entryId, actor.id, input.reason].filter((value, index) => index !== 0 || isUuidArg(value)),
    );
    if (!rows.length) {
      const { rows: existing } = await tx.query("SELECT voided_at FROM hq_reporting_entries WHERE id=$1::uuid", [input.entryId].filter(isUuidArg));
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
  limit?: number;
  /** The `nextCursor` of the previous page. */
  cursor?: string;
};

export type ReportingEntryPage = { entries: ReportingEntryView[]; nextCursor: string | null };

const DEFAULT_PAGE = 25;
const MAX_PAGE = 100;

/**
 * The entries of one project this actor may read, newest first.
 *
 * The audience is applied in SQL, not after loading: a member who is not an
 * entry's author never receives a sensitive body, a sensitive entry's
 * existence or a voided entry at all, so there is nothing to hide in the
 * browser and nothing for a serialized response to carry. Operators see
 * everything, voided entries included and marked. A denial returns an empty
 * page rather than an error, so an unrelated Captain cannot tell a project
 * with no updates from one they may not read.
 *
 * Keyset paged on `(submitted_at, id)` so a page cannot shift under a
 * concurrent insert, and no revision is ever joined.
 */
export async function readAuthorizedUpdates(
  actor: Actor,
  input: ReadUpdatesInput,
  db: BuilderQuery = builderDatabase(),
): Promise<ReportingEntryPage> {
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
  if (input.cursor) {
    const [at, id] = String(input.cursor).split("|");
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

/** One of the caller's own updates, with the project it belongs to so a list of them reads as something other than loose text. */
export type OwnReportingEntry = ReportingEntryView & { projectName: string };

export type OwnReportingEntryPage = { entries: OwnReportingEntry[]; nextCursor: string | null };

/**
 * Everything this member wrote in one edition, newest first, read-only.
 *
 * The author-only half of the permission contract, which `entryAudience` has
 * always stated ("the author keeps a read-only view while their Captain
 * capability is active") and which nothing could reach:
 * `readAuthorizedUpdates` decides `read` on the PROJECT first and answers an
 * empty page when that fails, so a Captain who was reassigned lost their own
 * sensitive notes along with the team's records. This is the path that does
 * not ask about the project at all.
 *
 * What it is not: a way back into the former team. Only rows this account
 * authored are selected, every one of them is returned `canEdit: false`
 * whatever the project now says, and no other team record is read. A current
 * `captain` capability is still required, because these notes exist only
 * because the account held it; losing the capability closes the page.
 *
 * Keyset paged on `(submitted_at, id)`, like the project list, and no
 * revision is joined.
 */
export async function readOwnUpdates(
  actor: Actor,
  input: { hackathonId: number; limit?: number; cursor?: string },
  db: BuilderQuery = builderDatabase(),
): Promise<OwnReportingEntryPage> {
  if (actor.kind !== "member") return { entries: [], nextCursor: null };
  if (!(await listActiveCapabilities(actor.id, db)).includes("captain")) return { entries: [], nextCursor: null };
  const limit = Math.max(1, Math.min(MAX_PAGE, Math.floor(input.limit ?? DEFAULT_PAGE)));
  const values: unknown[] = [input.hackathonId, actor.id];
  // `pr` is the period ENTRY_SELECT already joins, and it carries the
  // edition: no second join, and no project read inside the page.
  const where = ["pr.hackathon_id = $1", "e.author_kind = 'member'", "e.author_id = $2", "e.voided_at IS NULL"];
  if (input.cursor) {
    const [at, id] = String(input.cursor).split("|");
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
 * An entry's full version history, oldest first. Operators only, whoever
 * wrote the entry: the permission contract gives revision history to nobody
 * else, the author included, so a member caller gets an empty list rather
 * than a refusal that would confirm the entry exists.
 *
 * Paged on the version, which is the table's own uniqueness key, so history
 * stays an on-demand read rather than something a list query carries.
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

/** One period's state for one project. `basis` says how a completed period was completed, mirroring the stored outcome's own column. */
export type PeriodStatus = {
  periodId: string;
  periodSequence: number;
  mode: ReportingPeriodMode;
  startDate: string;
  endDate: string;
  /** The inclusive start instant, so a screen can tell whether this week is open at the instant it is rendering for. */
  startsAt: string;
  /** The exclusive end, which is the deadline a screen counts down to. */
  endsAt: string;
  nudgeAt: string | null;
  completed: boolean;
  basis: "entry" | "submission" | "none";
  /** Qualifying entries: neither voided nor late. Never the bodies. */
  entries: number;
  latestEntryAt: string | null;
  closed: boolean;
  /**
   * The project was not being counted for this period: it was paused. Never
   * a missed week, whatever `completed` says. Recorded on the outcome at
   * close, and derived live from the pause history before then.
   */
  exempt: boolean;
};

/**
 * A project's reporting state, the shape every dashboard reads. It carries
 * `projectName` and `imported` from the project itself, so a Captain or admin
 * surface can render a project with no imported team behind it without a
 * second lookup and without a reduced row.
 */
export type ProjectReportingStatus = {
  projectId: string;
  projectName: string;
  hackathonId: number;
  imported: boolean;
  eligibleFrom: string;
  paused: boolean;
  /** The project's current Captain, or null. An id, for a caller that has already earned the right to it. */
  captainUserId: string | null;
  submissionStatus: SubmissionStatus;
  /** The period open at the instant asked about, or null outside the campaign. */
  current: PeriodStatus | null;
  /** Periods this project was accountable for and did not complete. */
  missedPeriods: number;
  history: PeriodStatus[];
};

/** Colosseum's own signal, as phase 3's `interpretSubmission` wrote it. Never re-derived here. */
export type SubmissionStatus = "not_checked" | "submitted" | "not_submitted";

export type ReportingStatusInput = {
  hackathonId: number;
  /** Narrow to these projects; omit for every project in the edition's reporting. */
  projectIds?: readonly string[];
  atMs?: number;
  /** Include every period's state per project, not only the open one and the missed count. */
  includeHistory?: boolean;
};

type EntryTally = { entries: number; latestEntryAt: string | null; firstEntryId: string };

/**
 * Whether a project was accountable for a period: it had entered reporting
 * before the period ended, and was not under a pause when it ended. Its
 * negation is what `PeriodStatus.exempt` and the outcome's `exempt` column
 * both mean. A project
 * that joined mid-campaign therefore has no missed weeks before it arrived
 * ("no missed weeks are fabricated before a team's reporting start"), and a
 * pause stops future obligations without touching what is already recorded.
 *
 * The pause half reads the recorded intervals rather than the current
 * `paused_at`, because that column says only whether the project is paused
 * right now. While a pause is open the two agree exactly: the open interval
 * began before the period's end and has not ended, which is what
 * `pausedAt < endsAt` used to mean. What the intervals add is the answer
 * after the resume, where the column has nothing left to say and every week
 * of the exemption would otherwise turn into a missed week the moment
 * reporting started again. A week that both began and ended inside the
 * project's running time is accountable however many pauses surround it.
 */
const accountable = (eligibility: ReportingEligibility, period: ReportingPeriod) => {
  if (Date.parse(eligibility.eligibleFrom) >= Date.parse(period.endsAt)) return false;
  const ends = Date.parse(period.endsAt);
  return !eligibility.pauses.some(
    (pause) => Date.parse(pause.pausedAt) < ends && (pause.resumedAt == null || Date.parse(pause.resumedAt) >= ends),
  );
};

/**
 * Whether a confirmed Colosseum submission satisfies the final period.
 *
 * Only the submission-focus period, only a status phase 3's one
 * `interpretSubmission` actually wrote as `submitted`, and only on time: the
 * external deadline when an admin has recorded one
 * (`official_submission_deadline`, which exists precisely because Colosseum's
 * cutoff may be earlier than HQ's window), otherwise the period's own end. A
 * submission made before the final period still counts, which is why the
 * comparison is against the deadline rather than against the period's start.
 */
function submissionSatisfies(
  period: ReportingPeriod,
  project: { submissionStatus: SubmissionStatus; submittedAt: string | null },
  officialDeadline: string | null,
): boolean {
  if (period.mode !== "submission" || project.submissionStatus !== "submitted") return false;
  if (!project.submittedAt) return true;
  const deadline = Date.parse(officialDeadline ?? period.endsAt);
  return Date.parse(project.submittedAt) <= deadline;
}

/**
 * Every project's reporting state for one edition, in a fixed number of
 * grouped queries rather than one request per project: the eligibility rows
 * with their project and submission columns, the entry tallies grouped by
 * project and period, the persisted outcomes, and the current assignments.
 * No revision is touched and no body is selected, so a dashboard response
 * carries none.
 *
 * An outcome is authoritative wherever one exists, correction included. For a
 * period that has ended but has not been closed yet, the same rule
 * `closePeriod` would apply is computed live, so a dashboard is honest about
 * a missed week before the closure job has run rather than showing zero.
 */
export async function reportingStatus(db: BuilderQuery, input: ReportingStatusInput): Promise<ProjectReportingStatus[]> {
  const atMs = input.atMs ?? Date.now();
  const filter = input.projectIds ? [...new Set(input.projectIds)] : null;
  if (filter && !filter.length) return [];

  const [periods, eligibility, config] = await Promise.all([
    listReportingPeriods(db, input.hackathonId),
    listReportingEligibility(db, input.hackathonId),
    db.query("SELECT official_submission_deadline FROM hq_reporting_config WHERE hackathon_id = $1", [input.hackathonId]),
  ]);
  const officialDeadline = config.rows.length && config.rows[0].official_submission_deadline != null
    ? toIso(config.rows[0].official_submission_deadline) : null;
  const projects = filter ? eligibility.filter((row) => filter.includes(row.projectId)) : eligibility;
  if (!projects.length || !periods.length) return projects.map((row) => bareStatus(row, "not_checked"));
  const projectIds = projects.map((row) => row.projectId);

  const [tallies, outcomes, submissions, assignments] = await Promise.all([
    db.query(
      `SELECT e.project_id::text AS project_id, e.period_id::text AS period_id, count(*)::int AS entries,
              max(e.submitted_at) AS latest, (array_agg(e.id::text ORDER BY e.submitted_at, e.id))[1] AS first_entry
       FROM hq_reporting_entries e JOIN hq_reporting_periods p ON p.id = e.period_id
       WHERE p.hackathon_id = $1 AND e.project_id = ANY($2::uuid[]) AND e.voided_at IS NULL AND e.late = false
       GROUP BY e.project_id, e.period_id`,
      [input.hackathonId, projectIds],
    ),
    db.query(
      `SELECT o.project_id::text AS project_id, o.period_id::text AS period_id, o.completed, o.corrected_completed, o.basis, o.exempt, o.entry_id::text AS entry_id
       FROM hq_reporting_outcomes o JOIN hq_reporting_periods p ON p.id = o.period_id
       WHERE p.hackathon_id = $1 AND o.project_id = ANY($2::uuid[])`,
      [input.hackathonId, projectIds],
    ),
    db.query(
      `SELECT project_id::text AS project_id, submission_status, submitted_at FROM hq_project_onboarding WHERE project_id = ANY($1::uuid[])`,
      [projectIds],
    ),
    db.query(
      `SELECT project_id::text AS project_id, captain_user_id FROM hq_captain_assignments
       WHERE project_id = ANY($1::uuid[]) AND unassigned_at IS NULL AND captain_user_id IS NOT NULL`,
      [projectIds],
    ),
  ]);

  const key = (projectId: string, periodId: string) => `${projectId}|${periodId}`;
  const tallyBy = new Map<string, EntryTally>(tallies.rows.map((row) => [
    key(String(row.project_id), String(row.period_id)),
    { entries: Number(row.entries), latestEntryAt: row.latest == null ? null : toIso(row.latest), firstEntryId: String(row.first_entry) },
  ]));
  const outcomeBy = new Map(outcomes.rows.map((row) => [key(String(row.project_id), String(row.period_id)), row]));
  const submissionBy = new Map(submissions.rows.map((row) => [
    String(row.project_id),
    { submissionStatus: (row.submission_status ?? "not_checked") as SubmissionStatus, submittedAt: row.submitted_at == null ? null : toIso(row.submitted_at) },
  ]));
  const captainBy = new Map(assignments.rows.map((row) => [String(row.project_id), String(row.captain_user_id)]));

  return projects.map((project) => {
    const submission = submissionBy.get(project.projectId) ?? { submissionStatus: "not_checked" as SubmissionStatus, submittedAt: null };
    const history: PeriodStatus[] = [];
    let missed = 0;
    let current: PeriodStatus | null = null;
    for (const period of periods) {
      const tally = tallyBy.get(key(project.projectId, period.id));
      const outcome = outcomeBy.get(key(project.projectId, period.id));
      const isAccountable = accountable(project, period);
      const live: PeriodStatus["basis"] = tally ? "entry" : submissionSatisfies(period, submission, officialDeadline) ? "submission" : "none";
      const recorded = outcome
        ? { completed: Boolean(outcome.corrected_completed ?? outcome.completed), basis: toBasis(outcome.basis), exempt: Boolean(outcome.exempt) }
        // Before closure the pause history answers it; afterwards the row
        // does, which is what stops a lifted pause from turning into missed
        // weeks.
        : { completed: live !== "none", basis: live, exempt: !isAccountable };
      const status: PeriodStatus = {
        periodId: period.id, periodSequence: period.sequence, mode: period.mode,
        startDate: period.startDate, endDate: period.endDate, startsAt: period.startsAt, endsAt: period.endsAt, nudgeAt: period.nudgeAt,
        completed: recorded.completed, basis: recorded.basis, exempt: recorded.exempt,
        entries: tally?.entries ?? 0, latestEntryAt: tally?.latestEntryAt ?? null,
        closed: period.closedAt != null,
      };
      history.push(status);
      if (Date.parse(period.startsAt) <= atMs && atMs < Date.parse(period.endsAt)) current = status;
      else if (Date.parse(period.endsAt) <= atMs && !status.exempt && !status.completed) missed += 1;
    }
    return {
      projectId: project.projectId, projectName: project.projectName, hackathonId: project.hackathonId,
      imported: project.imported, eligibleFrom: project.eligibleFrom, paused: project.paused,
      captainUserId: captainBy.get(project.projectId) ?? null,
      submissionStatus: submission.submissionStatus,
      current, missedPeriods: missed,
      history: input.includeHistory ? history : [],
    };
  });
}

/** A project in reporting for an edition whose schedule has no periods yet. */
const bareStatus = (project: ReportingEligibility, submissionStatus: SubmissionStatus): ProjectReportingStatus => ({
  projectId: project.projectId, projectName: project.projectName, hackathonId: project.hackathonId,
  imported: project.imported, eligibleFrom: project.eligibleFrom, paused: project.paused,
  captainUserId: null, submissionStatus, current: null, missedPeriods: 0, history: [],
});

export type PeriodOutcome = {
  periodId: string;
  projectId: string;
  /** The factual on-time outcome recorded at close. Never rewritten. */
  completed: boolean;
  basis: "entry" | "submission" | "none";
  /** The project was paused when this period closed, so the period was excused rather than missed. */
  exempt: boolean;
  entryId: string | null;
  /** The Captain at close, null for unassigned. History: reassigning later does not change it. */
  captainUserId: string | null;
  closedAt: string;
  /** An admin's later correction of a mistaken outcome, or null. The effective answer is this when set, `completed` otherwise. */
  correctedCompleted: boolean | null;
  correctionReason: string | null;
};

/** The stored `basis` as the union, defaulting to "none" for anything the CHECK constraint could not have produced. */
const toBasis = (value: unknown): PeriodOutcome["basis"] => (value === "entry" || value === "submission" ? value : "none");

const toOutcome = (row: Record<string, unknown>): PeriodOutcome => ({
  periodId: String(row.period_id), projectId: String(row.project_id),
  completed: Boolean(row.completed), basis: toBasis(row.basis), exempt: Boolean(row.exempt),
  entryId: row.entry_id == null ? null : String(row.entry_id),
  captainUserId: row.captain_user_id == null ? null : String(row.captain_user_id),
  closedAt: toIso(row.closed_at),
  correctedCompleted: row.corrected_completed == null ? null : Boolean(row.corrected_completed),
  correctionReason: row.correction_reason == null ? null : String(row.correction_reason),
});

const OUTCOME_COLUMNS =
  "period_id::text AS period_id, project_id::text AS project_id, completed, basis, exempt, entry_id::text AS entry_id, captain_user_id, closed_at, corrected_completed, correction_reason";

export async function listPeriodOutcomes(db: BuilderQuery, periodId: string): Promise<PeriodOutcome[]> {
  const { rows } = await db.query(`SELECT ${OUTCOME_COLUMNS} FROM hq_reporting_outcomes WHERE period_id = $1::uuid ORDER BY project_id`, [periodId]);
  return rows.map(toOutcome);
}

export type ClosePeriodResult =
  | { ok: true; alreadyClosed: boolean; outcomes: PeriodOutcome[]; completed: number; missed: number }
  | { ok: false; reason: "not_found" | "not_ended" };

/**
 * Persists a period's outcomes and marks it closed.
 *
 * Idempotent, and deliberately so: a job that runs twice, or a manual close
 * after an automatic one, must not rewrite what was recorded. Every insert is
 * `ON CONFLICT DO NOTHING`, and a period that is already closed returns its
 * stored outcomes unchanged.
 *
 * The outcome records the factual on-time answer and the Captain responsible
 * at close, both as history: a late entry added afterwards is marked `late`
 * and never counted here, a reassignment later does not rewrite
 * `captain_user_id`, and an admin who believes an outcome is wrong corrects
 * it through `correctOutcome`, which writes beside the original rather than
 * over it.
 */
export async function closePeriod(
  db: BuilderDatabase | BuilderQuery,
  input: { periodId: string; actor: Actor; atMs?: number },
): Promise<ClosePeriodResult> {
  const atMs = input.atMs ?? Date.now();
  if (!isUuidArg(input.periodId)) return { ok: false, reason: "not_found" };
  return atomically(db, async (tx) => {
    const { rows } = await tx.query(`SELECT ${PERIOD_COLUMNS} FROM hq_reporting_periods WHERE id = $1::uuid FOR UPDATE`, [input.periodId]);
    if (!rows.length) return { ok: false, reason: "not_found" };
    const period = toPeriod(rows[0]);
    if (atMs < Date.parse(period.endsAt)) return { ok: false, reason: "not_ended" };
    if (period.closedAt) {
      const stored = await listPeriodOutcomes(tx, period.id);
      return {
        ok: true, alreadyClosed: true, outcomes: stored,
        completed: stored.filter((outcome) => outcome.completed && !outcome.exempt).length,
        missed: stored.filter((outcome) => !outcome.completed && !outcome.exempt).length,
      };
    }

    const statuses = await reportingStatus(tx, { hackathonId: period.hackathonId, atMs, includeHistory: true });
    const eligibility = new Map((await listReportingEligibility(tx, period.hackathonId)).map((row) => [row.projectId, row]));
    const { rows: firstEntries } = await tx.query(
      `SELECT DISTINCT ON (project_id) project_id::text AS project_id, id::text AS id FROM hq_reporting_entries
       WHERE period_id = $1::uuid AND voided_at IS NULL AND late = false ORDER BY project_id, submitted_at, id`,
      [period.id],
    );
    const entryByProject = new Map(firstEntries.map((row) => [String(row.project_id), String(row.id)]));

    for (const status of statuses) {
      const row = eligibility.get(status.projectId);
      // A project that entered reporting after this period ended was never
      // part of it and gets no row at all; one that was in reporting but
      // paused gets a row that says so. Closure used to skip the paused one
      // as well, which left nothing recording that the week had been
      // excused: the moment the pause was lifted, the same closed week read
      // back as accountable and missing.
      if (!row || Date.parse(row.eligibleFrom) >= Date.parse(period.endsAt)) continue;
      const state = status.history.find((candidate) => candidate.periodId === period.id);
      if (!state) continue;
      const exempt = !accountable(row, period);
      await tx.query(
        `INSERT INTO hq_reporting_outcomes (period_id, project_id, completed, basis, exempt, entry_id, captain_user_id)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7) ON CONFLICT (period_id, project_id) DO NOTHING`,
        [period.id, status.projectId, state.completed, state.basis, exempt, entryByProject.get(status.projectId) ?? null, status.captainUserId],
      );
    }
    await tx.query("UPDATE hq_reporting_periods SET closed_at = now() WHERE id = $1::uuid AND closed_at IS NULL", [period.id]);
    const outcomes = await listPeriodOutcomes(tx, period.id);
    const completed = outcomes.filter((outcome) => outcome.completed && !outcome.exempt).length;
    // An excused week is neither completed nor missed: counting it as missed
    // here would put a paused team into the very number the pause exists to
    // keep them out of.
    const missed = outcomes.filter((outcome) => !outcome.completed && !outcome.exempt).length;
    const exempt = outcomes.filter((outcome) => outcome.exempt).length;
    await recordAuditEvent(tx, {
      kind: "reporting.period_closed",
      actor: auditActor(input.actor),
      hackathonId: period.hackathonId,
      metadata: { periodId: period.id, sequence: period.sequence, mode: period.mode, projects: outcomes.length, completed, missed, exempt },
    });
    return { ok: true, alreadyClosed: false, outcomes, completed, missed };
  });
}

export type CorrectOutcomeResult =
  | { ok: true; outcome: PeriodOutcome }
  | { ok: false; reason: "not_found" | "not_authorized" | "reason_required" | "unchanged" };

/**
 * An admin's correction of a mistaken historical outcome. Requires a reason
 * and writes an audit event, per the plan; `completed` stays exactly as it
 * was recorded at close, so the original factual answer and the correction
 * are both readable afterwards.
 */
export async function correctOutcome(
  actor: Actor,
  input: { periodId: string; projectId: string; completed: boolean; reason: string; operatorId: string },
  db: BuilderDatabase | BuilderQuery = builderDatabase(),
): Promise<CorrectOutcomeResult> {
  if (actor.kind !== "operator") return { ok: false, reason: "not_authorized" };
  const reason = String(input.reason ?? "").trim();
  if (!reason) return { ok: false, reason: "reason_required" };
  return atomically(db, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE hq_reporting_outcomes SET corrected_completed = $3, corrected_at = now(), corrected_by_user_id = $4::uuid, correction_reason = $5
       WHERE period_id = $1::uuid AND project_id = $2::uuid AND COALESCE(corrected_completed, completed) <> $3
       RETURNING ${OUTCOME_COLUMNS}`,
      [input.periodId, input.projectId, input.completed, input.operatorId, reason],
    );
    if (!rows.length) {
      const { rows: existing } = await tx.query(
        "SELECT 1 FROM hq_reporting_outcomes WHERE period_id = $1::uuid AND project_id = $2::uuid", [input.periodId, input.projectId],
      );
      return { ok: false, reason: existing.length ? "unchanged" : "not_found" };
    }
    const outcome = toOutcome(rows[0]);
    const { rows: edition } = await tx.query("SELECT hackathon_id FROM hq_projects WHERE id = $1::uuid", [input.projectId]);
    await recordAuditEvent(tx, {
      kind: "reporting.outcome_corrected",
      actor: auditActor(actor),
      hackathonId: edition.length ? Number(edition[0].hackathon_id) : null,
      projectId: input.projectId,
      metadata: { periodId: input.periodId, originalCompleted: outcome.completed, correctedCompleted: input.completed, reason },
    });
    return { ok: true, outcome };
  });
}
