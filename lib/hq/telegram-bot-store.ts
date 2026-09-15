import "server-only";
import type { Actor } from "./actor";
import { authorizeProjectAction } from "./authz-decisions";
import { builderDatabase, type BuilderQuery } from "./builder-db";
import { reminderDispatchDecision, REMINDER_KIND } from "./reminder-dispatch";
import type { TelegramSender } from "./telegram-bot-api";

/**
 * The Telegram bot's durable state: processed updates, callback references,
 * drafts, the outgoing queue and the chat binding.
 *
 * Every one of these is state the plan requires to survive the request that
 * created it. A serverless deployment has no memory between invocations, so
 * an in-process map would deduplicate nothing, expire nothing and lose every
 * draft between two messages; "Use durable state, not process memory" is the
 * plan's own phrasing and this module is where it is met.
 *
 * Nothing here decides anything. It stores no permission, applies no
 * authorization and holds no copy of a reporting rule: the flow re-reads the
 * account, the capability, the assignment, the period and the version from
 * the real services on every single read and every single write, and these
 * rows only ever say what was being talked about, never what is allowed.
 *
 * The tables and the reasoning behind each column are documented in
 * `scripts/hq/builder-schema.sql`.
 */

/** A draft lives long enough to write an update and no longer. */
export const DRAFT_TTL_MS = 30 * 60_000;
/** A navigation button stays pressable for a day, because an inline keyboard stays in the chat history. */
export const ACTION_TTL_MS = 24 * 60 * 60_000;
/** A button that writes expires with the draft it belongs to. */
export const WRITE_ACTION_TTL_MS = DRAFT_TTL_MS;
/** How long a processed update id and a finished delivery are kept before `purgeExpiredBotState` removes them. */
export const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const DELIVERY_RETENTION_MS = 90 * 24 * 60 * 60_000;
/** How long one invocation may hold an update before another may take it over. Longer than the route's own maxDuration. */
export const UPDATE_LEASE_MS = 60_000;
/** How many times one Telegram update may be attempted before it is left for an operator. */
export const MAX_UPDATE_ATTEMPTS = 5;
/** How long a drain may hold a queued message before another drain may take it over. */
export const SEND_CLAIM_MS = 60_000;

const toIso = (value: unknown) => (value instanceof Date ? value : new Date(String(value))).toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/* -------------------------------------------------------------------------
 * Webhook receipts
 * ---------------------------------------------------------------------- */

export type UpdateClaim =
  | { accepted: true; attempts: number }
  | { accepted: false; reason: "already_done" | "in_progress" | "exhausted" };

/**
 * Takes a lease on one Telegram update, or says why it will not.
 *
 * Telegram retries any delivery it did not get a 200 for, so the same
 * `update_id` arrives again after a timeout, a deploy or a cold start. Three
 * different situations hide behind that one id, and treating them alike is
 * how an interrupted save became a silent loss:
 *
 * - **Finished** (`state = 'done'`): the work is behind us. Answer 200 and do
 *   nothing. This is the only terminal state.
 * - **In flight** (`state = 'processing'` with a live lease): another
 *   invocation has it right now. Answer 200 and do nothing, because an
 *   overlapping delivery is a duplicate, not a reason to run twice.
 * - **Interrupted** (`state = 'failed'`, or `'processing'` with an expired
 *   lease): the previous attempt died. **Re-claim it.** Refusing here is what
 *   turned one transient database error into an update that was never saved
 *   and could never be retried.
 *
 * Re-claiming is only safe because the handler's writes are atomic: the
 * callback consumption, the draft claim, the reporting write and the durable
 * confirmation all commit in one transaction, so an interrupted attempt left
 * nothing behind to repeat. `attempts` is the stop: past
 * `MAX_UPDATE_ATTEMPTS` the row is `exhausted` and an operator can see it,
 * rather than a retry loop.
 */
export async function claimTelegramUpdate(db: BuilderQuery, updateId: number, now = Date.now()): Promise<UpdateClaim> {
  const at = new Date(now).toISOString();
  const lease = new Date(now + UPDATE_LEASE_MS).toISOString();
  const { rows } = await db.query(
    `INSERT INTO hq_telegram_updates (update_id, state, attempts, lease_expires_at)
     VALUES ($1::bigint, 'processing', 1, $3::timestamptz)
     ON CONFLICT (update_id) DO UPDATE
       SET state = 'processing',
           attempts = hq_telegram_updates.attempts + 1,
           lease_expires_at = $3::timestamptz,
           completed_at = NULL
     WHERE hq_telegram_updates.state <> 'done'
       AND hq_telegram_updates.attempts < $4
       AND (hq_telegram_updates.state = 'failed' OR hq_telegram_updates.lease_expires_at IS NULL OR hq_telegram_updates.lease_expires_at <= $2::timestamptz)
     RETURNING attempts`,
    [updateId, at, lease, MAX_UPDATE_ATTEMPTS],
  );
  if (rows.length) return { accepted: true, attempts: Number(rows[0].attempts) };
  const { rows: existing } = await db.query(
    "SELECT state, attempts, lease_expires_at FROM hq_telegram_updates WHERE update_id = $1::bigint",
    [updateId],
  );
  if (!existing.length) return { accepted: false, reason: "in_progress" };
  if (String(existing[0].state) === "done") return { accepted: false, reason: "already_done" };
  if (Number(existing[0].attempts) >= MAX_UPDATE_ATTEMPTS) return { accepted: false, reason: "exhausted" };
  return { accepted: false, reason: "in_progress" };
}

/**
 * Records how the claimed update ended.
 *
 * `done` is terminal and releases nothing else. `failed` releases the lease
 * so Telegram's next delivery of the same id can pick the work up again,
 * which is the whole point: the handler's writes are atomic, so there is
 * nothing half-finished for that retry to duplicate.
 */
export async function finishTelegramUpdate(db: BuilderQuery, updateId: number, state: "done" | "failed", error?: string): Promise<void> {
  await db.query(
    `UPDATE hq_telegram_updates
     SET state = $2, completed_at = now(), last_error = $3,
         lease_expires_at = CASE WHEN $2 = 'done' THEN lease_expires_at ELSE NULL END
     WHERE update_id = $1::bigint`,
    // Truncated and never the update's own text: a handler passes a code, not
    // what somebody typed.
    [updateId, state, error ? String(error).slice(0, 200) : null],
  );
}

/* -------------------------------------------------------------------------
 * The chat binding
 * ---------------------------------------------------------------------- */

export type BotChat = { userId: string; chatId: string; messagingEnabled: boolean };

/**
 * Remembers which private chat this account talks to the bot in.
 *
 * Written on every inbound message, because a chat id can change (a person
 * deletes the chat and starts again) and because the consent row may have
 * been created from `/hq/account` before the chat existed. It writes the chat
 * and nothing else: `messaging_enabled` stays exactly as the person left it,
 * so opening the chat is never mistaken for agreeing to be messaged.
 *
 * It also records WHICH verified Telegram identity opened the chat, and
 * brings `telegram_user_id` up to date with it. The `DO UPDATE` used to set
 * the chat alone, so a relinked account kept the previous account's Telegram
 * id on the row and nothing could tell the two apart; `deliverableBotChat`
 * and `deliverable()` compare the binding against the identity verified NOW,
 * so a chat only ever receives messages for the account that opened it.
 */
export async function bindBotChat(db: BuilderQuery, input: { userId: string; telegramUserId: string; chatId: string }): Promise<void> {
  await db.query(
    `INSERT INTO hq_telegram_bot_consent (user_id, telegram_user_id, messaging_enabled, chat_id, chat_bound_telegram_user_id)
     VALUES ($1, $2::bigint, false, $3::bigint, $2::bigint)
     ON CONFLICT (user_id) DO UPDATE SET
       chat_id = EXCLUDED.chat_id,
       telegram_user_id = EXCLUDED.telegram_user_id,
       chat_bound_telegram_user_id = EXCLUDED.chat_bound_telegram_user_id,
       updated_at = now()`,
    [input.userId, input.telegramUserId, input.chatId],
  );
}

/**
 * The chat to deliver into, or null when there is none, messaging is off, or
 * the chat on file was opened by a Telegram account that is no longer the one
 * connected to this HQ account.
 *
 * The join is the whole point: a chat id alone says where a message would go,
 * never whose chat it is. Phase 8's reminder and `deliverable()` below both
 * read through this rule.
 */
export async function deliverableBotChat(db: BuilderQuery, userId: string): Promise<BotChat | null> {
  const { rows } = await db.query(
    `SELECT c.user_id, c.chat_id::text AS chat_id, c.messaging_enabled
     FROM hq_telegram_bot_consent c
     JOIN hq_auth_telegram_identity i
       ON i.user_id = c.user_id AND i.telegram_user_id = c.chat_bound_telegram_user_id
     WHERE c.user_id = $1 AND c.messaging_enabled AND c.chat_id IS NOT NULL`,
    [userId],
  );
  return rows.length ? { userId: String(rows[0].user_id), chatId: String(rows[0].chat_id), messagingEnabled: true } : null;
}

/** Whether this account has agreed to bot messages. Read fresh on every update, never carried in chat state. */
export async function botMessagingEnabled(db: BuilderQuery, userId: string): Promise<boolean> {
  const { rows } = await db.query("SELECT messaging_enabled FROM hq_telegram_bot_consent WHERE user_id = $1", [userId]);
  return rows.length ? Boolean(rows[0].messaging_enabled) : false;
}

/* -------------------------------------------------------------------------
 * Callback references
 * ---------------------------------------------------------------------- */

/** What a button does. The flow switches on this; the client never sees it. */
export type BotActionKind =
  | "menu"
  | "projects.page"
  | "compose.page"
  | "project.open"
  | "project.compose"
  | "notes.page"
  | "note.open"
  | "note.edit"
  | "draft.save"
  | "draft.cancel"
  | "draft.rewrite"
  | "draft.visibility"
  | "draft.save_into_current"
  | "draft.save_over"
  | "consent.enable";

/**
 * The kinds that write to HQ, and which are therefore consumed exactly once,
 * INSIDE the transaction that does the writing. A double tap, a forwarded
 * keyboard and a Telegram redelivery all find the row consumed; an attempt
 * that dies before its commit leaves it unconsumed, so the retry works.
 *
 * `consent.enable` is deliberately not here. `setBotConsent` is idempotent by
 * construction (asking for the state the account is already in writes nothing
 * and records nothing), so claiming it would buy nothing and would have to
 * open a second transaction inside the first.
 */
const WRITE_KINDS: ReadonlySet<BotActionKind> = new Set(["draft.save", "draft.save_into_current", "draft.save_over"]);

export const isWriteAction = (kind: BotActionKind): boolean => WRITE_KINDS.has(kind);

/** The kinds that act on a draft, and which are therefore pinned to the exact draft generation they were rendered from. */
const DRAFT_KINDS: ReadonlySet<BotActionKind> = new Set([
  "draft.save", "draft.save_into_current", "draft.save_over", "draft.cancel", "draft.rewrite", "draft.visibility",
]);

export const isDraftAction = (kind: BotActionKind): boolean => DRAFT_KINDS.has(kind);

export type BotAction = {
  id: string;
  userId: string;
  chatId: string;
  kind: BotActionKind;
  projectId: string | null;
  periodId: string | null;
  entryId: string | null;
  expectedVersion: number | null;
  page: number;
  cursor: string | null;
  visibility: "shared" | "sensitive" | null;
  singleUse: boolean;
  /** The composing session this button was rendered from, and the state it was rendered from. Both must still match. */
  draftId: string | null;
  draftRevision: number | null;
  /** The edition this button is scoped to, or null for the account's default one. */
  hackathonId: number | null;
};

export type NewBotAction = {
  userId: string;
  chatId: string;
  kind: BotActionKind;
  projectId?: string | null;
  periodId?: string | null;
  entryId?: string | null;
  expectedVersion?: number | null;
  page?: number;
  cursor?: string | null;
  visibility?: "shared" | "sensitive" | null;
  draftId?: string | null;
  draftRevision?: number | null;
  hackathonId?: number | null;
};

const toAction = (row: Record<string, unknown>): BotAction => ({
  id: String(row.id),
  userId: String(row.user_id),
  chatId: String(row.chat_id),
  kind: String(row.kind) as BotActionKind,
  projectId: row.project_id == null ? null : String(row.project_id),
  periodId: row.period_id == null ? null : String(row.period_id),
  entryId: row.entry_id == null ? null : String(row.entry_id),
  expectedVersion: row.expected_version == null ? null : Number(row.expected_version),
  page: Number(row.page ?? 0),
  cursor: row.cursor == null ? null : String(row.cursor),
  visibility: row.visibility == null ? null : (String(row.visibility) as "shared" | "sensitive"),
  singleUse: Boolean(row.single_use),
  draftId: row.draft_id == null ? null : String(row.draft_id),
  draftRevision: row.draft_revision == null ? null : Number(row.draft_revision),
  hackathonId: row.hackathon_id == null ? null : Number(row.hackathon_id),
});

const ACTION_COLUMNS =
  "id::text AS id, user_id, chat_id::text AS chat_id, kind, project_id::text AS project_id, period_id::text AS period_id, " +
  "entry_id::text AS entry_id, expected_version, page, cursor, visibility, single_use, draft_id::text AS draft_id, draft_revision, hackathon_id";

/**
 * Mints one opaque button reference, bound to the account and chat it was
 * built for. The id is what travels in `callback_data`; the meaning never
 * leaves the server.
 */
export async function createBotAction(db: BuilderQuery, input: NewBotAction, now = Date.now()): Promise<BotAction> {
  const singleUse = isWriteAction(input.kind);
  const bound = isDraftAction(input.kind);
  const expires = new Date(now + (bound ? WRITE_ACTION_TTL_MS : ACTION_TTL_MS)).toISOString();
  const { rows } = await db.query(
    `INSERT INTO hq_telegram_actions (user_id, chat_id, kind, project_id, period_id, entry_id, expected_version, page, cursor, visibility, single_use, draft_id, draft_revision, expires_at, hackathon_id)
     VALUES ($1, $2::bigint, $3, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9, $10, $11, $12::uuid, $13, $14::timestamptz, $15) RETURNING ${ACTION_COLUMNS}`,
    [
      input.userId, input.chatId, input.kind,
      isUuid(input.projectId) ? input.projectId : null,
      isUuid(input.periodId) ? input.periodId : null,
      isUuid(input.entryId) ? input.entryId : null,
      input.expectedVersion ?? null,
      Math.max(0, Math.floor(input.page ?? 0)),
      input.cursor ? String(input.cursor).slice(0, 200) : null,
      input.visibility ?? null,
      singleUse,
      isUuid(input.draftId) ? input.draftId : null,
      input.draftRevision ?? null,
      expires,
      input.hackathonId ?? null,
    ],
  );
  return toAction(rows[0]);
}

export type ActionRead =
  | { ok: true; action: BotAction }
  | { ok: false; reason: "not_found" | "expired" | "already_used" | "wrong_chat" };

/**
 * Resolves a pressed button. Reads only: nothing here is consumed.
 *
 * Every guard the plan names is checked against the stored row rather than
 * against the payload: the id has to exist, it has to belong to THIS account,
 * it has to have been minted for THIS chat, it has to still be within its
 * expiry, and a single-use row has to be unconsumed.
 *
 * Consuming is deliberately NOT done here. A button that writes is consumed
 * by `consumeBotAction` inside the same transaction as the write it
 * authorises, so an attempt that dies before that commit leaves the button
 * usable and Telegram's retry works. Consuming first is what turned one
 * transient failure into an action the person could never complete.
 *
 * What this does not do is authorize anything. A resolved action says only
 * which button was pressed; the flow still re-reads the identity, the
 * capability, the assignment, the draft generation, the period and the entry
 * version before it writes, which is what makes a stale button after a
 * reassignment or a revocation fail on the facts rather than on the token.
 */
export async function readBotAction(
  db: BuilderQuery,
  input: { id: string; userId: string; chatId: string },
  now = Date.now(),
): Promise<ActionRead> {
  if (!isUuid(input.id)) return { ok: false, reason: "not_found" };
  const { rows } = await db.query(`SELECT ${ACTION_COLUMNS}, expires_at, consumed_at FROM hq_telegram_actions WHERE id = $1::uuid`, [input.id]);
  if (!rows.length) return { ok: false, reason: "not_found" };
  const row = rows[0];
  // A reference minted for somebody else is not "someone else's button", it
  // is a miss: the answer is identical to an id that never existed.
  if (String(row.user_id) !== input.userId) return { ok: false, reason: "not_found" };
  if (String(row.chat_id) !== input.chatId) return { ok: false, reason: "wrong_chat" };
  if (Date.parse(toIso(row.expires_at)) <= now) return { ok: false, reason: "expired" };
  const action = toAction(row);
  if (action.singleUse && row.consumed_at != null) return { ok: false, reason: "already_used" };
  return { ok: true, action };
}

/**
 * Consumes a single-use button, inside the caller's transaction.
 *
 * Returns false when it was already consumed, which is how a double tap and a
 * redelivered press both come back without a second write. Because this
 * commits with the write it authorises, an interrupted attempt rolls it back
 * together with everything else and the retry finds the button intact.
 */
export async function consumeBotAction(tx: BuilderQuery, input: { id: string; userId: string; updateId: number }): Promise<boolean> {
  if (!isUuid(input.id)) return false;
  const { rows } = await tx.query(
    `UPDATE hq_telegram_actions SET consumed_at = now(), consumed_update_id = $3::bigint
     WHERE id = $1::uuid AND user_id = $2 AND consumed_at IS NULL RETURNING id`,
    [input.id, input.userId, input.updateId],
  );
  return rows.length > 0;
}

/* -------------------------------------------------------------------------
 * Drafts
 * ---------------------------------------------------------------------- */

export type BotDraft = {
  /** The composing session. Changes when a new compose replaces the old one, never on an edit to the same one. */
  id: string;
  /** The state this draft is in. Incremented by every write, so a button rendered from an earlier state is detectably stale. */
  revision: number;
  userId: string;
  chatId: string;
  step: "awaiting_text" | "preview";
  projectId: string;
  hackathonId: number;
  periodId: string | null;
  entryId: string | null;
  expectedVersion: number | null;
  visibility: "shared" | "sensitive";
  body: string | null;
  expiresAt: string;
};

const toDraft = (row: Record<string, unknown>): BotDraft => ({
  id: String(row.id),
  revision: Number(row.revision),
  userId: String(row.user_id),
  chatId: String(row.chat_id),
  step: row.step === "preview" ? "preview" : "awaiting_text",
  projectId: String(row.project_id),
  hackathonId: Number(row.hackathon_id),
  periodId: row.period_id == null ? null : String(row.period_id),
  entryId: row.entry_id == null ? null : String(row.entry_id),
  expectedVersion: row.expected_version == null ? null : Number(row.expected_version),
  visibility: row.visibility === "sensitive" ? "sensitive" : "shared",
  body: row.body == null ? null : String(row.body),
  expiresAt: toIso(row.expires_at),
});

const DRAFT_COLUMNS =
  "id::text AS id, revision, user_id, chat_id::text AS chat_id, step, project_id::text AS project_id, hackathon_id, period_id::text AS period_id, " +
  "entry_id::text AS entry_id, expected_version, visibility, body, expires_at";

/** The live draft for this account and chat, or null when there is none or it has expired. An expired draft is never returned. */
export async function readBotDraft(db: BuilderQuery, input: { userId: string; chatId: string }, now = Date.now()): Promise<BotDraft | null> {
  const { rows } = await db.query(
    `SELECT ${DRAFT_COLUMNS} FROM hq_telegram_drafts WHERE user_id = $1 AND chat_id = $2::bigint AND expires_at > $3::timestamptz`,
    [input.userId, input.chatId, new Date(now).toISOString()],
  );
  return rows.length ? toDraft(rows[0]) : null;
}

/** The fields a caller supplies. `id` and `revision` are the store's to hand out. */
export type NewBotDraft = Omit<BotDraft, "id" | "revision" | "expiresAt"> & { expiresAt?: string };

/**
 * Starts a new composing session, replacing whatever was in this chat.
 *
 * A NEW `id`, which is what makes every button rendered from the previous
 * draft dead rather than merely old: pressing Save on a preview from the team
 * you were writing about a minute ago must not save the team you are writing
 * about now. Those buttons are deleted here as well, so the keyboard in the
 * chat cannot even be resolved.
 */
export async function startBotDraft(db: BuilderQuery, draft: NewBotDraft, now = Date.now()): Promise<BotDraft> {
  await db.query("DELETE FROM hq_telegram_actions WHERE user_id = $1 AND chat_id = $2::bigint AND draft_id IS NOT NULL", [draft.userId, draft.chatId]);
  const { rows } = await db.query(
    `INSERT INTO hq_telegram_drafts (user_id, chat_id, step, project_id, hackathon_id, period_id, entry_id, expected_version, visibility, body, expires_at)
     VALUES ($1, $2::bigint, $3, $4::uuid, $5, $6::uuid, $7::uuid, $8, $9, $10, $11::timestamptz)
     ON CONFLICT (user_id, chat_id) DO UPDATE SET
       id = gen_random_uuid(), revision = 1,
       step = EXCLUDED.step, project_id = EXCLUDED.project_id, hackathon_id = EXCLUDED.hackathon_id,
       period_id = EXCLUDED.period_id, entry_id = EXCLUDED.entry_id, expected_version = EXCLUDED.expected_version,
       visibility = EXCLUDED.visibility, body = EXCLUDED.body, expires_at = EXCLUDED.expires_at, updated_at = now()
     RETURNING ${DRAFT_COLUMNS}`,
    [
      draft.userId, draft.chatId, draft.step, draft.projectId, draft.hackathonId,
      isUuid(draft.periodId) ? draft.periodId : null,
      isUuid(draft.entryId) ? draft.entryId : null,
      draft.expectedVersion ?? null, draft.visibility, draft.body ?? null,
      draft.expiresAt ?? new Date(now + DRAFT_TTL_MS).toISOString(),
    ],
  );
  return toDraft(rows[0]);
}

export type DraftUpdate = Partial<Pick<BotDraft, "step" | "periodId" | "entryId" | "expectedVersion" | "visibility" | "body">>;

/**
 * Advances the draft this account has in this chat, keeping its `id` and
 * bumping its `revision`.
 *
 * The bump is the point. Every button that touches a draft records the
 * revision it was rendered from, so the moment the draft changes, every
 * keyboard already in the chat stops applying to it. That is what stops an
 * old Share button from re-opening a different team's sensitive note, and
 * what stops two previews of one draft from both saving.
 *
 * Conditional on `expectedRevision`, so two presses racing to change the same
 * draft cannot both win. Returns null when the draft is gone, has expired, or
 * has already moved on.
 */
export async function advanceBotDraft(
  db: BuilderQuery,
  input: { userId: string; chatId: string; draftId: string; expectedRevision: number } & DraftUpdate,
  now = Date.now(),
): Promise<BotDraft | null> {
  if (!isUuid(input.draftId)) return null;
  const { rows } = await db.query(
    `UPDATE hq_telegram_drafts SET
       revision = revision + 1,
       step = COALESCE($5, step),
       period_id = CASE WHEN $6::boolean THEN $7::uuid ELSE period_id END,
       entry_id = CASE WHEN $8::boolean THEN $9::uuid ELSE entry_id END,
       expected_version = CASE WHEN $10::boolean THEN $11::int ELSE expected_version END,
       visibility = COALESCE($12, visibility),
       body = CASE WHEN $13::boolean THEN $14 ELSE body END,
       expires_at = $15::timestamptz,
       updated_at = now()
     WHERE user_id = $1 AND chat_id = $2::bigint AND id = $3::uuid AND revision = $4 AND expires_at > now()
     RETURNING ${DRAFT_COLUMNS}`,
    [
      input.userId, input.chatId, input.draftId, input.expectedRevision,
      input.step ?? null,
      "periodId" in input, isUuid(input.periodId) ? input.periodId : null,
      "entryId" in input, isUuid(input.entryId) ? input.entryId : null,
      "expectedVersion" in input, input.expectedVersion ?? null,
      input.visibility ?? null,
      "body" in input, input.body ?? null,
      new Date(now + DRAFT_TTL_MS).toISOString(),
    ],
  );
  return rows.length ? toDraft(rows[0]) : null;
}

/**
 * Takes the draft out of the chat, and with it every button that was minted
 * for it. Unconditional: used by Cancel, by /cancel and after a completed
 * save, where the caller has already established which draft it means.
 */
export async function clearBotDraft(db: BuilderQuery, input: { userId: string; chatId: string }): Promise<void> {
  await db.query("DELETE FROM hq_telegram_actions WHERE user_id = $1 AND chat_id = $2::bigint AND draft_id IS NOT NULL", [input.userId, input.chatId]);
  await db.query("DELETE FROM hq_telegram_drafts WHERE user_id = $1 AND chat_id = $2::bigint", [input.userId, input.chatId]);
}

/**
 * Claims one draft generation for a save, by deleting it.
 *
 * This is the logical-save claim, and it runs INSIDE the transaction that
 * writes the reporting entry. Exactly one caller can delete a given
 * `(id, revision)` pair, so two buttons that both refer to the same logical
 * update, minted from two renders of the same draft, produce one entry
 * between them however they race. If the transaction rolls back, the draft
 * comes back with it, which is what lets a refused save keep the person's
 * text on screen.
 *
 * Returns null when the draft is gone, expired, or has moved on since the
 * button was rendered.
 */
export async function claimBotDraft(
  tx: BuilderQuery,
  input: { userId: string; chatId: string; draftId: string; expectedRevision: number },
  now = Date.now(),
): Promise<BotDraft | null> {
  if (!isUuid(input.draftId)) return null;
  const { rows } = await tx.query(
    `DELETE FROM hq_telegram_drafts
     WHERE user_id = $1 AND chat_id = $2::bigint AND id = $3::uuid AND revision = $4 AND expires_at > $5::timestamptz
     RETURNING ${DRAFT_COLUMNS}`,
    [input.userId, input.chatId, input.draftId, input.expectedRevision, new Date(now).toISOString()],
  );
  return rows.length ? toDraft(rows[0]) : null;
}

/* -------------------------------------------------------------------------
 * The outgoing queue
 * ---------------------------------------------------------------------- */

/**
 * Queues a message that must not be lost.
 *
 * Enqueued INSIDE the caller's transaction, which is the whole point: the
 * save confirmation commits with the entry or does not exist, so there is no
 * state in which an update was written and nothing was ever going to say so,
 * and no state in which a confirmation outlives a rolled back save.
 *
 * `dedupeKey` makes the delivery at most once per event even though the queue
 * is drained at least once: a second enqueue of the same key writes nothing
 * and returns null. Phase 8's reminder uses the same mechanism keyed on
 * Captain, edition, period and type.
 *
 * `userId`, `projectId` and `hackathonId` are not decoration. They are what
 * `flushBotMessages` re-checks immediately before it sends, so a message
 * queued while somebody was a Captain with messaging on is not delivered
 * after they turned messaging off, unlinked Telegram, moved to another chat
 * or lost the assignment it names.
 *
 * NO UPDATE BODY IS EVER PASSED HERE. Previews repeat what somebody typed and
 * are sent directly instead, so a sensitive note never reaches this table.
 */
export async function enqueueBotMessage(
  db: BuilderQuery,
  input: {
    chatId: string;
    userId: string | null;
    kind: string;
    body: string;
    replyMarkup?: unknown;
    dedupeKey?: string;
    projectId?: string | null;
    hackathonId?: number | null;
  },
): Promise<string | null> {
  const { rows } = await db.query(
    `INSERT INTO hq_telegram_outgoing (chat_id, user_id, kind, body, reply_markup, dedupe_key, project_id, hackathon_id)
     VALUES ($1::bigint, $2, $3, $4, $5::jsonb, $6, $7::uuid, $8)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id::text AS id`,
    [
      input.chatId, input.userId, input.kind, input.body,
      input.replyMarkup == null ? null : JSON.stringify(input.replyMarkup),
      input.dedupeKey ?? null,
      isUuid(input.projectId) ? input.projectId : null,
      input.hackathonId ?? null,
    ],
  );
  return rows.length ? String(rows[0].id) : null;
}

/** How many attempts a queued message gets before it is left alone for an operator to look at. */
export const MAX_SEND_ATTEMPTS = 5;

/** Backoff between attempts, so a struggling Telegram is not hammered. Bounded, and overridden by Telegram's own retry_after. */
const RETRY_BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];

export type FlushResult = { sent: number; failed: number; retrying: number; skipped: number };

type ClaimedMessage = {
  id: string;
  chatId: string;
  userId: string | null;
  kind: string;
  body: string;
  replyMarkup: unknown;
  attempts: number;
  projectId: string | null;
  hackathonId: number | null;
};

/**
 * Why a queued message was dropped instead of sent. Recorded on the row so an
 * admin can see it. A reminder can additionally answer with any
 * `ReminderSkipReason`, which is why this is widened to a string at the call
 * site rather than being the only vocabulary.
 */
export type SendSkipReason =
  | "messaging_disabled"
  | "telegram_disconnected"
  | "chat_changed"
  | "chat_not_bound"
  | "not_authorized"
  | "message_too_long";

/**
 * What the pre-send check decided: send this row, optionally with a body
 * rebuilt from the state that exists now, or skip it with a reason.
 */
type DeliveryDecision = { ok: true; body?: string } | { ok: false; reason: string };

/**
 * Whether this row may still be delivered, decided from the state that exists
 * NOW rather than from the state that existed when it was queued.
 *
 * A queued message is not a licence. Between the enqueue and the drain the
 * person can turn bot messages off, disconnect Telegram (which revokes
 * messaging in the same operation), start a fresh chat with the bot, or lose
 * the assignment the message is about. All four have to stop the send, and
 * the last one is why phase 8's reminder can reuse this untouched: a
 * reassigned project must not appear in a message.
 */
async function deliverable(db: BuilderQuery, message: ClaimedMessage, atMs: number): Promise<DeliveryDecision> {
  if (!message.userId) return { ok: true };
  const { rows } = await db.query(
    `SELECT c.messaging_enabled, c.chat_id::text AS chat_id, c.chat_bound_telegram_user_id::text AS bound_to,
            i.user_id AS identity, i.telegram_user_id::text AS telegram_user_id
     FROM hq_telegram_bot_consent c
     LEFT JOIN hq_auth_telegram_identity i ON i.user_id = c.user_id
     WHERE c.user_id = $1`,
    [message.userId],
  );
  if (!rows.length || !rows[0].identity) return { ok: false, reason: "telegram_disconnected" };
  if (!rows[0].messaging_enabled) return { ok: false, reason: "messaging_disabled" };
  // A relink or a fresh chat gives a new chat id. The old row must not be
  // delivered into a chat the person has moved on from.
  if (rows[0].chat_id == null || String(rows[0].chat_id) !== message.chatId) return { ok: false, reason: "chat_changed" };
  // And the chat must be one the identity connected NOW actually opened.
  // Matching the chat id alone says where a message would go, never whose
  // chat it is: disconnecting Telegram and connecting a different account
  // left the previous account's chat on the row, and a queued message went
  // to the previous account's private chat.
  if (rows[0].bound_to == null || String(rows[0].bound_to) !== String(rows[0].telegram_user_id)) {
    return { ok: false, reason: "chat_not_bound" };
  }

  // A reminder names several projects, so the single-project check below has
  // nothing to check. It is re-decided and REBUILT instead, against the state
  // that exists at this instant, by the module that owns that decision. This
  // runs for every consumer of the queue, the webhook's drain included.
  if (message.kind === REMINDER_KIND) {
    const decision = await reminderDispatchDecision(db, { outgoingId: message.id, atMs });
    return decision.ok ? { ok: true, body: decision.body } : { ok: false, reason: decision.reason };
  }

  if (!message.projectId || message.hackathonId == null) return { ok: true };
  const actor: Actor = { kind: "member", id: message.userId, name: "", email: null, capabilities: new Set(), telegram: null };
  const decision = await authorizeProjectAction(actor, { projectId: message.projectId, hackathonId: message.hackathonId, action: "read" });
  return decision.allowed ? { ok: true } : { ok: false, reason: "not_authorized" };
}

/**
 * Drains the queue, and records what Telegram said.
 *
 * Called after the webhook's own transaction has committed, so a send failure
 * can never roll back a saved update.
 *
 * Rows are **claimed** before they are sent: one atomic update takes a
 * bounded batch, stamps an owner and an expiry on each, and only that owner
 * may complete them. Two drains running at once therefore divide the queue
 * instead of both sending the same row, and a worker that dies mid-send
 * releases its rows when the claim expires rather than stranding them. What
 * this does not promise is exactly-once delivery: a claim that expires after
 * Telegram accepted the message is a genuine unknown, and the honest answer
 * is that it may be delivered twice, not that it cannot be.
 *
 * A timeout is recorded as a retry with `code: "timeout"` and NOT as a
 * failure: delivery is unknown in that case, and the plan is explicit that an
 * uncertain delivery must not be presented as a guaranteed one. Permanent
 * refusals, a blocked bot above all, stop immediately rather than being
 * retried into a rate limit, and Telegram's own `retry_after` is respected
 * rather than discarded.
 */
export async function flushBotMessages(
  db: BuilderQuery,
  sender: TelegramSender,
  options: { limit?: number; now?: number; owner?: string } = {},
): Promise<FlushResult> {
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 10)));
  const now = options.now ?? Date.now();
  const owner = options.owner ?? `${Math.random().toString(36).slice(2)}${now.toString(36)}`;
  const at = new Date(now).toISOString();
  const { rows } = await db.query(
    `UPDATE hq_telegram_outgoing SET
       attempts = attempts + 1, claimed_at = $1::timestamptz, claim_expires_at = $2::timestamptz, claimed_by = $3
     WHERE id IN (
       SELECT id FROM hq_telegram_outgoing
       WHERE state = 'queued' AND attempts < $4
         AND (next_attempt_at IS NULL OR next_attempt_at <= $1::timestamptz)
         AND (claim_expires_at IS NULL OR claim_expires_at <= $1::timestamptz)
       ORDER BY created_at LIMIT $5 FOR UPDATE SKIP LOCKED
     )
     RETURNING id::text AS id, chat_id::text AS chat_id, user_id, kind, body, reply_markup, attempts,
               project_id::text AS project_id, hackathon_id`,
    [at, new Date(now + SEND_CLAIM_MS).toISOString(), owner, MAX_SEND_ATTEMPTS, limit],
  );
  const result: FlushResult = { sent: 0, failed: 0, retrying: 0, skipped: 0 };
  for (const row of rows) {
    const message: ClaimedMessage = {
      id: String(row.id), chatId: String(row.chat_id), userId: row.user_id == null ? null : String(row.user_id),
      kind: String(row.kind), body: String(row.body), replyMarkup: row.reply_markup ?? null, attempts: Number(row.attempts),
      projectId: row.project_id == null ? null : String(row.project_id),
      hackathonId: row.hackathon_id == null ? null : Number(row.hackathon_id),
    };
    // A FRESH reading of the clock per message, not the one the caller took
    // when the pass began: a pass that closes periods, prepares reminders and
    // then sends up to two hundred messages, each with its own timeout, can
    // be minutes older by the time it reaches this row.
    const dispatchAt = options.now ?? Date.now();
    const decision = await deliverable(db, message, dispatchAt);
    if (!decision.ok) {
      await db.query(
        "UPDATE hq_telegram_outgoing SET state='skipped', skip_reason=$2, claimed_by=NULL, claim_expires_at=NULL WHERE id=$1::uuid AND claimed_by=$3",
        [message.id, decision.reason, owner],
      );
      result.skipped += 1;
      continue;
    }
    // The body as of this instant, which for a reminder is rebuilt rather
    // than the one that was stored when it was queued.
    const text = decision.body ?? message.body;
    if (decision.body != null && decision.body !== message.body) {
      await db.query("UPDATE hq_telegram_outgoing SET body=$2 WHERE id=$1::uuid AND claimed_by=$3", [message.id, decision.body, owner]);
    }
    const outcome = await sender.sendMessage({
      chatId: message.chatId,
      text,
      parseMode: "HTML",
      ...(message.replyMarkup ? { replyMarkup: message.replyMarkup } : {}),
    });
    if (outcome.ok) {
      await db.query(
        `UPDATE hq_telegram_outgoing SET state='sent', sent_at=now(), provider_message_id=$2, last_error=NULL,
           claimed_by=NULL, claim_expires_at=NULL WHERE id=$1::uuid AND claimed_by=$3`,
        [message.id, outcome.messageId, owner],
      );
      result.sent += 1;
      continue;
    }
    const giveUp = !outcome.retryable || message.attempts >= MAX_SEND_ATTEMPTS;
    const backoff = outcome.retryAfterSeconds
      ? outcome.retryAfterSeconds * 1000
      : RETRY_BACKOFF_MS[Math.min(message.attempts - 1, RETRY_BACKOFF_MS.length - 1)];
    await db.query(
      `UPDATE hq_telegram_outgoing SET state=$2, last_error=$3, skip_reason=$4, next_attempt_at=$5::timestamptz,
         claimed_by=NULL, claim_expires_at=NULL WHERE id=$1::uuid AND claimed_by=$6`,
      [
        message.id,
        giveUp ? (outcome.retryable ? "failed" : "skipped") : "queued",
        // Telegram's own words, for an operator, PREFIXED WITH THE CODE.
        // Never rendered into a chat. The code matters on its own: a timeout
        // carries no detail at all, so recording only the detail threw away
        // the one fact that says delivery is unknown rather than failed.
        [outcome.code, outcome.detail ? String(outcome.detail) : null].filter(Boolean).join(": ").slice(0, 300) || null,
        giveUp && !outcome.retryable ? outcome.code : null,
        giveUp ? null : new Date(now + backoff).toISOString(),
        owner,
      ],
    );
    if (giveUp) result.failed += 1;
    else result.retrying += 1;
  }
  return result;
}

/* -------------------------------------------------------------------------
 * Retention
 * ---------------------------------------------------------------------- */

export type PurgeResult = { drafts: number; actions: number; receipts: number; deliveries: number };

/**
 * Removes bot state that has done its job. Safe to run repeatedly and from
 * anywhere; phase 8's scheduled job is what will call it on a timer.
 *
 * The drafts go first, because they are the only rows here that hold text
 * somebody wrote. Delivery rows are kept far longer than receipts, because
 * they are the record an admin reads when a Captain says they were never
 * reminded, and they carry no update text by construction.
 */
export async function purgeExpiredBotState(db: BuilderQuery = builderDatabase(), now = Date.now()): Promise<PurgeResult> {
  const at = new Date(now).toISOString();
  const drafts = await db.query("DELETE FROM hq_telegram_drafts WHERE expires_at <= $1::timestamptz RETURNING user_id", [at]);
  const actions = await db.query("DELETE FROM hq_telegram_actions WHERE expires_at <= $1::timestamptz RETURNING id", [at]);
  // Only receipts that are actually finished. A row still in 'processing'
  // under a live lease, or one recorded as 'failed' and waiting for
  // Telegram's next delivery, is work in progress; sweeping it would let the
  // retry run as if the update had never been seen.
  const receipts = await db.query(
    "DELETE FROM hq_telegram_updates WHERE state = 'done' AND received_at <= $1::timestamptz RETURNING update_id",
    [new Date(now - RECEIPT_RETENTION_MS).toISOString()],
  );
  const deliveries = await db.query(
    "DELETE FROM hq_telegram_outgoing WHERE state <> 'queued' AND created_at <= $1::timestamptz RETURNING id",
    [new Date(now - DELIVERY_RETENTION_MS).toISOString()],
  );
  return { drafts: drafts.rows.length, actions: actions.rows.length, receipts: receipts.rows.length, deliveries: deliveries.rows.length };
}
