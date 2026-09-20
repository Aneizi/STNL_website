import "server-only";
import type { Actor } from "./actor";
import { authorizeProjectAction } from "./authz-decisions";
import { builderDatabase, type BuilderQuery } from "./builder-db";
import { reminderDispatchDecision, REMINDER_KIND } from "./reminder-dispatch";
import { TELEGRAM_REQUEST_TIMEOUT_MS, type TelegramSender } from "./telegram-bot-api";
import { activeTelegramIdentitySql } from "./telegram-identity-sql";

/**
 * Durable receipts, callbacks, drafts, outbox and chat bindings survive serverless
 * invocations. Stored context grants no access: each operation rechecks live identity,
 * consent, capabilities and project permissions. The outbox also rechecks at dispatch.
 */

/** A draft lives long enough to write an update and no longer. */
export const DRAFT_TTL_MS = 30 * 60_000;
/** A navigation button stays pressable for a day, because an inline keyboard stays in the chat history. */
const ACTION_TTL_MS = 24 * 60 * 60_000;
/** A button that writes expires with the draft it belongs to. */
const WRITE_ACTION_TTL_MS = DRAFT_TTL_MS;
/** How long a processed update id and a finished delivery are kept before `purgeExpiredBotState` removes them. */
const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const DELIVERY_RETENTION_MS = 90 * 24 * 60 * 60_000;
/** How long one invocation may hold an update before another may take it over. Longer than the route's own maxDuration. */
export const UPDATE_LEASE_MS = 90_000;
/** How many times one Telegram update may be attempted before it is left for an operator. */
export const MAX_UPDATE_ATTEMPTS = 5;
/** How long a drain may hold a queued message before another drain may take it over. */
const SEND_CLAIM_MS = 60_000;

const toIso = (value: unknown) => (value instanceof Date ? value : new Date(String(value))).toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/* -------------------------------------------------------------------------
 * Webhook receipts
 * ---------------------------------------------------------------------- */

type UpdateClaim =
  | { accepted: true; attempts: number }
  | { accepted: false; reason: "already_done" | "in_progress" | "exhausted" };

/**
 * Lease an update: done is terminal; a live processing lease is busy; failed or
 * expired processing can be reclaimed up to MAX_UPDATE_ATTEMPTS. Retrying is safe
 * because action consumption, draft claim, entry and confirmation commit together.
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
  if (existing[0].state === "processing" && existing[0].lease_expires_at != null && Date.parse(toIso(existing[0].lease_expires_at)) > now) {
    return { accepted: false, reason: "in_progress" };
  }
  if (Number(existing[0].attempts) >= MAX_UPDATE_ATTEMPTS) return { accepted: false, reason: "exhausted" };
  return { accepted: false, reason: "in_progress" };
}

/**
 * Finish only the claimed attempt. Done is terminal; failure releases its lease
 * for a retry whose atomic writes cannot leave a half-completed save.
 */
export async function finishTelegramUpdate(db: BuilderQuery, updateId: number, state: "done" | "failed", error?: string, attempt?: number): Promise<void> {
  await db.query(
    `UPDATE hq_telegram_updates
     SET state = $2, completed_at = now(), last_error = $3,
         lease_expires_at = CASE WHEN $2 = 'done' THEN lease_expires_at ELSE NULL END
     WHERE update_id = $1::bigint AND state <> 'done' AND ($4::int IS NULL OR attempts = $4)`,
    // Truncated and never the update's own text: a handler passes a code, not
    // what somebody typed.
    [updateId, state, error ? String(error).slice(0, 200) : null, attempt ?? null],
  );
}

/* -------------------------------------------------------------------------
 * The chat binding
 * ---------------------------------------------------------------------- */

type BotChat = { userId: string; chatId: string; messagingEnabled: boolean };

/**
 * Bind the private chat to the verified Telegram identity that opened it.
 * Opening a chat never enables messaging consent. Updating the identity binding
 * prevents a relinked account from inheriting the previous identity's destination.
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
 * Return a consented chat only when its bound identity is still connected.
 * A chat id identifies a destination, not who currently owns it.
 */
export async function deliverableBotChat(db: BuilderQuery, userId: string): Promise<BotChat | null> {
  const { rows } = await db.query(
    `SELECT c.user_id, c.chat_id::text AS chat_id, c.messaging_enabled
     FROM hq_telegram_bot_consent c
     JOIN hq_auth_telegram_identity i
       ON i.user_id = c.user_id AND i.telegram_user_id = c.chat_bound_telegram_user_id
     WHERE c.user_id = $1 AND c.messaging_enabled AND c.chat_id IS NOT NULL AND ${activeTelegramIdentitySql()}`,
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
  | "draft.preview"
  | "draft.review"
  | "draft.save_into_current"
  | "draft.save_over"
  | "consent.enable";

/**
 * Write actions are consumed inside the writing transaction so retries and double
 * taps cannot repeat a committed change. consent.enable is separately idempotent
 * and must not open a nested transaction just to consume a callback.
 */
const WRITE_KINDS: ReadonlySet<BotActionKind> = new Set(["draft.save", "draft.save_into_current", "draft.save_over"]);

export const isWriteAction = (kind: BotActionKind): boolean => WRITE_KINDS.has(kind);

/** The kinds that act on a draft, and which are therefore pinned to the exact draft generation they were rendered from. */
const DRAFT_KINDS: ReadonlySet<BotActionKind> = new Set([
  "draft.save", "draft.save_into_current", "draft.save_over", "draft.cancel", "draft.rewrite", "draft.visibility", "draft.preview", "draft.review",
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

type NewBotAction = {
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
  /** Navigation reminders remain usable throughout their period. Draft buttons keep the short draft TTL. */
  expiresAt?: string;
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

/** Mint an account/chat-bound opaque callback id; its meaning stays server-side. */
export async function createBotAction(db: BuilderQuery, input: NewBotAction, now = Date.now()): Promise<BotAction> {
  const singleUse = isWriteAction(input.kind);
  const bound = isDraftAction(input.kind);
  const expires = new Date(bound ? now + WRITE_ACTION_TTL_MS : input.expiresAt ?? now + ACTION_TTL_MS).toISOString();
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

type ActionRead =
  | { ok: true; action: BotAction }
  | { ok: false; reason: "not_found" | "expired" | "already_used" | "wrong_chat" };

/**
 * Resolve only an unexpired, unconsumed callback for this account and chat.
 * This grants no permission and consumes nothing: the flow rechecks identity,
 * capability, assignment, draft generation, period and version; the writing
 * transaction consumes the action so a rolled-back save can be retried.
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
 * Consume inside the writing transaction. A duplicate returns false; rollback
 * restores the callback together with the failed save.
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
type NewBotDraft = Omit<BotDraft, "id" | "revision" | "expiresAt"> & { expiresAt?: string };

/**
 * Replace the chat draft with a new generation and retire its old callbacks,
 * so an earlier preview cannot save the newly composed team's text.
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

type DraftUpdate = Partial<Pick<BotDraft, "step" | "periodId" | "entryId" | "expectedVersion" | "visibility" | "body">>;

/**
 * Keep the draft id and conditionally advance expectedRevision. Old keyboards
 * become stale, including audience toggles; competing changes cannot both win.
 * Return null if the draft is gone, expired or already advanced.
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
     WHERE user_id = $1 AND chat_id = $2::bigint AND id = $3::uuid AND revision = $4 AND expires_at > $16::timestamptz
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
      new Date(now).toISOString(),
    ],
  );
  return rows.length ? toDraft(rows[0]) : null;
}

/** Clear the identified draft and its callbacks after cancel or completed save. */
export async function clearBotDraft(db: BuilderQuery, input: { userId: string; chatId: string }): Promise<void> {
  await db.query("DELETE FROM hq_telegram_actions WHERE user_id = $1 AND chat_id = $2::bigint AND draft_id IS NOT NULL", [input.userId, input.chatId]);
  await db.query("DELETE FROM hq_telegram_drafts WHERE user_id = $1 AND chat_id = $2::bigint", [input.userId, input.chatId]);
}

/**
 * Delete one exact draft id/revision inside the saving transaction. Competing
 * buttons produce one entry; rollback restores the text. Gone, expired or changed
 * drafts return null.
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
 * Enqueue inside the saving transaction: confirmation and entry commit together.
 * A dedupe key prevents duplicate queue records, not duplicate uncertain sends.
 * Recipient/project fields support live dispatch checks after unlink, consent
 * withdrawal, chat change or reassignment. Never enqueue update bodies; previews
 * are sent directly so sensitive text cannot enter the outbox.
 */
export async function enqueueBotMessage(
  db: BuilderQuery,
  input: {
    chatId: string;
    userId: string;
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

export type FlushResult = { sent: number; failed: number; retrying: number; skipped: number; stoppedOnBudget?: boolean };

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

/** A fresh delivery decision, including a reminder's rebuilt body or refusal reason. */
type DeliveryDecision = { ok: true; body?: string } | { ok: false; reason: string };

/**
 * Revalidate immediately before sending. Queue-time identity, consent, chat and
 * assignment may have changed; any revoked relationship must stop delivery.
 */
async function deliverable(db: BuilderQuery, message: ClaimedMessage, atMs: number): Promise<DeliveryDecision> {
  // Account deletion nulls the history row's foreign key. It revokes the
  // destination; it must never turn a protected message into a public one.
  if (!message.userId) return { ok: false, reason: "telegram_disconnected" };
  const { rows } = await db.query(
    `SELECT c.messaging_enabled, c.chat_id::text AS chat_id, c.chat_bound_telegram_user_id::text AS bound_to,
            i.user_id AS identity, i.telegram_user_id::text AS telegram_user_id
     FROM hq_telegram_bot_consent c
     LEFT JOIN hq_auth_telegram_identity i ON i.user_id = c.user_id AND ${activeTelegramIdentitySql()}
     WHERE c.user_id = $1`,
    [message.userId],
  );
  if (!rows.length || !rows[0].identity) return { ok: false, reason: "telegram_disconnected" };
  if (!rows[0].messaging_enabled) return { ok: false, reason: "messaging_disabled" };
  // A relink or a fresh chat gives a new chat id. The old row must not be
  // delivered into a chat the person has moved on from.
  if (rows[0].chat_id == null || String(rows[0].chat_id) !== message.chatId) return { ok: false, reason: "chat_changed" };
  // The connected identity must have opened this chat; relinking cannot inherit it.
  if (rows[0].bound_to == null || String(rows[0].bound_to) !== String(rows[0].telegram_user_id)) {
    return { ok: false, reason: "chat_not_bound" };
  }

  // Multi-project reminders rebuild from current state in every drain, including webhooks.
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
 * Drain after the save commits so delivery failure cannot roll back an entry.
 * Claim each row with owner/expiry and fence completion to that owner. Expired
 * claims recover, but an unanswered accepted send can be delivered twice.
 * Record timeouts as uncertain retries, honor retry_after, and stop permanent
 * refusals such as a blocked bot.
 */
export async function flushBotMessages(
  db: BuilderQuery,
  sender: TelegramSender,
  options: { limit?: number; now?: number; owner?: string; deadlineMs?: number; outgoingId?: string } = {},
): Promise<FlushResult> {
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 10)));
  const owner = options.owner ?? crypto.randomUUID();
  const deadlineMs = options.deadlineMs ?? Date.now() + 20_000;
  const result: FlushResult = { sent: 0, failed: 0, retrying: 0, skipped: 0 };
  // An invocation can die during its final allowed attempt. Such a row can
  // never be claimed again; resolve it explicitly and preserve uncertainty.
  const exhausted = await db.query(
    `UPDATE hq_telegram_outgoing SET state = 'failed',
       last_error = 'network: delivery worker interrupted during its final attempt',
       claimed_by = NULL, claim_expires_at = NULL, next_attempt_at = NULL
     WHERE state = 'queued' AND attempts >= $1
       AND (claim_expires_at IS NULL OR claim_expires_at <= $2::timestamptz)
       AND ($3::uuid IS NULL OR id = $3::uuid)
     RETURNING id`,
    [MAX_SEND_ATTEMPTS, new Date(options.now ?? Date.now()).toISOString(), options.outgoingId ?? null],
  );
  result.failed += exhausted.rows.length;
  // Claim only the next message. Claiming a whole batch lets later rows'
  // leases expire while earlier sends are still in flight.
  for (let index = 0; index < limit; index += 1) {
    if (Date.now() + TELEGRAM_REQUEST_TIMEOUT_MS >= deadlineMs) {
      result.stoppedOnBudget = true;
      break;
    }
    const now = options.now ?? Date.now();
    const at = new Date(now).toISOString();
    const { rows } = await db.query(
      `UPDATE hq_telegram_outgoing SET
       attempts = attempts + 1, claimed_at = $1::timestamptz, claim_expires_at = $2::timestamptz, claimed_by = $3
     WHERE id IN (
       SELECT id FROM hq_telegram_outgoing
       WHERE state = 'queued' AND attempts < $4
         AND (next_attempt_at IS NULL OR next_attempt_at <= $1::timestamptz)
         AND (claim_expires_at IS NULL OR claim_expires_at <= $1::timestamptz)
         AND ($5::uuid IS NULL OR id = $5::uuid)
       ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     RETURNING id::text AS id, chat_id::text AS chat_id, user_id, kind, body, reply_markup, attempts,
               project_id::text AS project_id, hackathon_id`,
      [at, new Date(now + SEND_CLAIM_MS).toISOString(), owner, MAX_SEND_ATTEMPTS, options.outgoingId ?? null],
    );
    if (!rows.length) break;
    const row = rows[0];
    const message: ClaimedMessage = {
      id: String(row.id), chatId: String(row.chat_id), userId: row.user_id == null ? null : String(row.user_id),
      kind: String(row.kind), body: String(row.body), replyMarkup: row.reply_markup ?? null, attempts: Number(row.attempts),
      projectId: row.project_id == null ? null : String(row.project_id),
      hackathonId: row.hackathon_id == null ? null : Number(row.hackathon_id),
    };
    // Read the clock per message; earlier sends may have consumed significant time.
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
    // Authorization can itself take time. A row that was never handed to
    // Telegram spends no attempt and is immediately available to another run.
    if (Date.now() + TELEGRAM_REQUEST_TIMEOUT_MS >= deadlineMs) {
      await db.query(
        "UPDATE hq_telegram_outgoing SET attempts=attempts-1, claimed_by=NULL, claim_expires_at=NULL WHERE id=$1::uuid AND claimed_by=$2",
        [message.id, owner],
      );
      result.stoppedOnBudget = true;
      break;
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
        giveUp ? null : new Date((options.now ?? Date.now()) + backoff).toISOString(),
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
 * Purge expired chat state and retained completed history. Drafts hold user text
 * and expire early; delivery records hold no update text and remain for inspection.
 */
export async function purgeExpiredBotState(db: BuilderQuery = builderDatabase(), now = Date.now()): Promise<PurgeResult> {
  const at = new Date(now).toISOString();
  const drafts = await db.query("DELETE FROM hq_telegram_drafts WHERE expires_at <= $1::timestamptz RETURNING user_id", [at]);
  const actions = await db.query("DELETE FROM hq_telegram_actions WHERE expires_at <= $1::timestamptz RETURNING id", [at]);
  // Keep unfinished receipts: deleting them would erase retry/deduplication state.
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
