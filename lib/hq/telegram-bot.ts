import "server-only";
import { telegramMemberActor, type MemberActor } from "./actor";
import { authorizeProjectAction, getActorCapabilities } from "./authz";
import { builderDatabase, type BuilderDatabase, type BuilderQuery } from "./builder-db";
import { builderStore } from "./builder-store";
import { memberAuthOrigin } from "./member-auth-config";
import { CAPTAIN_PATH } from "./member-routes";
import {
  captainReportingBoard,
  type CaptainReportingCard,
} from "./reporting-surface";
import {
  createUpdate,
  editUpdate,
  listReportingPeriods,
  MAX_BODY_LENGTH,
  readAuthorizedUpdates,
  readOwnUpdates,
  reportingStatus,
  type OwnReportingEntry,
  type ReportingEntryView,
  type ReportingPeriod,
} from "./reporting";
import { byOutstandingFirst } from "./reporting-view";
import { updateCharacterCount } from "./reporting-body";
import { setBotConsent } from "./telegram-consent";
import {
  advanceBotDraft,
  bindBotChat,
  botMessagingEnabled,
  claimBotDraft,
  clearBotDraft,
  consumeBotAction,
  createBotAction,
  enqueueBotMessage,
  isDraftAction,
  isWriteAction,
  readBotAction,
  readBotDraft,
  startBotDraft,
  type BotAction,
  type BotActionKind,
  type BotDraft,
} from "./telegram-bot-store";
import {
  BOT_COPY,
  conflictMessages,
  escapeHtml,
  inlineKeyboard,
  LABELS,
  openHqButton,
  ownNoteMessages,
  page,
  periodChangedMessages,
  previewMessages,
  projectListLine,
  projectMessage,
  refusalMessages,
  reportingRefusal,
  savedMessage,
  snippet,
  weekLine,
  type Button,
  type Keyboard,
  type ProjectSummary,
} from "./telegram-bot-view";

/**
 * Deterministic commands and menus; only the requested draft-text step accepts free text.
 * All reporting rules and writes stay in the shared reporting service. Re-read identity,
 * consent, capability, assignment, period and version on every press; stored callbacks
 * grant no permission. Escape all interpolated names, contacts and update bodies.
 */

/** Telegram's inbound shapes, narrowed to the fields this bot reads. Everything else in a payload is ignored. */
type TelegramChat = { id: number | string; type?: string };
type TelegramUser = { id: number | string; is_bot?: boolean };
type TelegramMessage = { message_id?: number; chat?: TelegramChat; from?: TelegramUser; text?: string };
type TelegramCallbackQuery = { id: string; from?: TelegramUser; data?: string; message?: TelegramMessage };
export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

/**
 * Menus/previews are sent directly and can be rebuilt after failure. They may
 * contain draft text, so they never enter the durable outgoing queue.
 */
type BotReply = { chatId: string; text: string; keyboard: Keyboard; newMessage?: boolean };

/** Page through content in one message, showing save controls after the full preview and audience. */
async function pagedReplies(
  session: Session,
  texts: readonly string[],
  keyboard: Keyboard,
  index: number,
  pageButton: (label: string, index: number) => Promise<Button>,
  lastPageKeyboard: Keyboard = [],
): Promise<BotReply[]> {
  const view = page(texts, index, 1);
  const navigation: Button[] = [];
  if (view.hasPrevious) navigation.push(await pageButton(LABELS.previous, view.index - 1));
  if (view.hasNext) navigation.push(await pageButton(LABELS.next, view.index + 1));
  return [{
    chatId: session.chatId,
    text: `${view.items[0]}${texts.length > 1 ? `\n\nPage ${view.index + 1} of ${texts.length}` : ""}`,
    keyboard: [...(!view.hasNext ? lastPageKeyboard : []), navigation, ...keyboard].filter((row) => row.length),
  }];
}

export type BotOutcome = {
  replies: BotReply[];
  /** Telegram requires an answer to every callback query, or the client spins until it times out. */
  answer: { callbackQueryId: string; text?: string } | null;
  /** True when something durable was queued, so the caller drains the queue after committing. */
  queued: boolean;
  /** A log-safe code, never an update body, name or token. */
  outcome: string;
};

type BotContext = {
  db?: BuilderDatabase;
  now?: number;
  /** A retry of the same webhook delivery may need to rebuild lost controls. */
  retry?: boolean;
  /** The public HQ origin, for the Open HQ buttons. Null when none is configured, and then no link button is offered. */
  hqOrigin?: string | null;
};

type Session = {
  db: BuilderDatabase;
  now: number;
  actor: MemberActor;
  chatId: string;
  hqOrigin: string | null;
  updateId: number;
  retry: boolean;
  /**
   * The edition this press is scoped to, or null for the account's default
   * one. Set from the pressed button, and inherited by every button minted
   * during the press, so a notification about one hackathon cannot open
   * another one's teams. Null for a message, which is always the default.
   */
  hackathonId: number | null;
};

const NOTHING: BotOutcome = { replies: [], answer: null, queued: false, outcome: "ignored" };

const hqLink = (origin: string | null, path: string) => (origin ? `${origin}${path}` : null);

/** How many of the account's own notes one page of My notes shows. Paged on the service's own cursor, not a cap. */
const OWN_NOTES_PAGE = 4;

/** The Captain board is where every Open HQ button points, because that is the screen this bot mirrors. One definition, in ./member-routes. */
const ACCOUNT_PATH = "/hq/account";

/* -------------------------------------------------------------------------
 * Keyboards
 * ---------------------------------------------------------------------- */

/**
 * Build opaque callbacks. Draft controls must use draftButton so both generation
 * and revision are bound; a replaced or changed preview cannot act on current text.
 */
async function button(session: Session, text: string, action: Omit<Parameters<typeof createBotAction>[1], "userId" | "chatId">): Promise<Button> {
  if (isDraftAction(action.kind) && !action.draftId) {
    throw new Error(`the ${action.kind} button must be bound to a draft`);
  }
  // The edition travels with the press: a button minted while answering a
  // reminder about one hackathon stays inside that hackathon, and one minted
  // from the ordinary menu carries null and means "the default one".
  const row = await createBotAction(
    session.db,
    { hackathonId: session.hackathonId, ...action, userId: session.actor.id, chatId: session.chatId },
    session.now,
  );
  return { text, callbackId: row.id };
}

/** A button bound to one generation of one draft. */
const draftButton = (
  session: Session,
  draft: BotDraft,
  text: string,
  action: Omit<Parameters<typeof createBotAction>[1], "userId" | "chatId" | "draftId" | "draftRevision">,
): Promise<Button> => button(session, text, { ...action, hackathonId: draft.hackathonId, draftId: draft.id, draftRevision: draft.revision });

async function mainMenu(session: Session, notice?: string): Promise<BotReply> {
  const [projects, add, notes] = await Promise.all([
    button(session, LABELS.myProjects, { kind: "projects.page", page: 0 }),
    button(session, LABELS.addUpdate, { kind: "compose.page", page: 0 }),
    button(session, LABELS.myNotes, { kind: "notes.page", page: 0 }),
  ]);
  return {
    chatId: session.chatId,
    text: `${notice ? `${escapeHtml(notice)}\n\n` : ""}<b>${BOT_COPY.menuTitle}</b>\n${BOT_COPY.menuBody}`,
    keyboard: [[projects], [add], [notes], openHqButton(hqLink(session.hqOrigin, CAPTAIN_PATH))],
  };
}

const toSummary = (card: CaptainReportingCard): ProjectSummary => ({
  projectId: card.status.projectId,
  projectName: card.status.projectName,
  current: card.current,
  missedPeriods: card.status.missedPeriods,
});

/** Read the shared Captain board in one batch and use the same outstanding-first order. */
async function loadBoard(session: Session): Promise<{ hackathonId: number; cards: CaptainReportingCard[] } | null> {
  // The edition the press named, when it named one. `captainReportingBoard`
  // reads only this account's own current assignments in it, so an edition
  // arriving on a callback grants nothing: a Captain with no assignments
  // there gets an empty board, exactly as they would from the menu.
  const hackathonId = session.hackathonId ?? (await builderStore().currentHackathonId());
  if (hackathonId === null) return null;
  const board = await captainReportingBoard(session.actor, hackathonId, session.db, session.now);
  const cards = [...board.cards].sort((a, b) =>
    byOutstandingFirst(
      { current: a.current, missedPeriods: a.status.missedPeriods, projectName: a.status.projectName },
      { current: b.current, missedPeriods: b.status.missedPeriods, projectName: b.status.projectName },
    ),
  );
  return { hackathonId, cards };
}

/** The project list, for browsing or for picking one to write to. Paged, because a Captain can hold more than a screenful. */
async function projectListReply(session: Session, index: number, intent: "open" | "compose"): Promise<BotReply> {
  const board = await loadBoard(session);
  if (!board || !board.cards.length) {
    return { chatId: session.chatId, text: BOT_COPY.noProjects, keyboard: [[await button(session, LABELS.back, { kind: "menu" })]] };
  }
  const view = page(board.cards, index);
  const rows: Keyboard = [];
  const lines: string[] = [`<b>${intent === "compose" ? BOT_COPY.chooseProject : BOT_COPY.projectsTitle}</b>`];
  for (const card of view.items) {
    const summary = toSummary(card);
    lines.push("", projectListLine(summary));
    rows.push([
      await button(session, summary.projectName, {
        kind: intent === "compose" ? "project.compose" : "project.open",
        projectId: summary.projectId,
      }),
    ]);
  }
  const listKind: BotActionKind = intent === "compose" ? "compose.page" : "projects.page";
  const previous = view.hasPrevious ? await button(session, LABELS.previous, { kind: listKind, page: view.index - 1 }) : null;
  const next = view.hasNext ? await button(session, LABELS.next, { kind: listKind, page: view.index + 1 }) : null;
  rows.push([previous, next].filter((entry): entry is Button => entry !== null));
  rows.push([await button(session, LABELS.back, { kind: "menu" })]);
  return { chatId: session.chatId, text: lines.join("\n"), keyboard: rows.filter((row) => row.length) };
}

/**
 * Read current authorized notes; SQL enforces audience. Offer rewrite only where
 * the reporting service currently permits editing, never from callback history.
 */
async function projectReply(session: Session, card: CaptainReportingCard): Promise<BotReply> {
  const summary = toSummary(card);
  const rows: Keyboard = [[await button(session, LABELS.addUpdate, { kind: "project.compose", projectId: summary.projectId })]];
  const own = card.entries.filter((entry) => entry.authorIsYou && entry.canEdit).slice(0, 3);
  for (const entry of own) {
    rows.push([
      await button(session, `${LABELS.edit}: ${snippet(entry.body, 28)}`, {
        kind: "note.edit",
        projectId: summary.projectId,
        entryId: entry.id,
        expectedVersion: entry.version,
      }),
    ]);
  }
  rows.push([await button(session, LABELS.backToProjects, { kind: "projects.page", page: 0 })]);
  rows.push(openHqButton(hqLink(session.hqOrigin, CAPTAIN_PATH)));
  return { chatId: session.chatId, text: projectMessage(summary, card.teamContact), keyboard: rows.filter((row) => row.length) };
}

/**
 * Show audience before save and sensitive controls only when allowed. Every
 * control binds this exact draft generation/revision and expires when it changes.
 */
async function previewReplies(session: Session, draft: BotDraft, summary: ProjectSummary, mayUseSensitive: boolean, index = 0): Promise<BotReply[]> {
  const save = await draftButton(session, draft, LABELS.save, { kind: "draft.save", projectId: draft.projectId });
  const rows: Keyboard = [
    [
      await draftButton(session, draft, LABELS.edit, { kind: "draft.rewrite", projectId: draft.projectId }),
    ],
  ];
  if (mayUseSensitive) {
    rows.push([
      draft.visibility === "shared"
        ? await draftButton(session, draft, LABELS.markSensitive, { kind: "draft.visibility", visibility: "sensitive" })
        : await draftButton(session, draft, `${LABELS.markShared} ${snippet(summary.projectName, 40)}`, { kind: "draft.visibility", visibility: "shared" }),
    ]);
  }
  rows.push([await draftButton(session, draft, LABELS.cancel, { kind: "draft.cancel" })]);
  rows.push(openHqButton(hqLink(session.hqOrigin, CAPTAIN_PATH)));
  return pagedReplies(session, previewMessages(summary, draft.body ?? "", draft.visibility), rows, index,
    (text, page) => draftButton(session, draft, text, { kind: "draft.preview", page }), [[save]]);
}

/* -------------------------------------------------------------------------
 * The entry point
 * ---------------------------------------------------------------------- */

/**
 * Gate each update on live identity and messaging consent. Starting the bot
 * confirms reminders for any member; reporting also requires Captain access.
 */
export async function handleTelegramUpdate(update: TelegramUpdate, context: BotContext = {}): Promise<BotOutcome> {
  const db = context.db ?? builderDatabase();
  const now = context.now ?? Date.now();
  const hqOrigin = context.hqOrigin !== undefined ? context.hqOrigin : memberAuthOrigin();

  // Telegram message edits do not bypass HQ's explicit revision/conflict flow.
  if (update.edited_message || update.channel_post) return { ...NOTHING, outcome: "ignored_edit" };

  const message = update.message;
  const callback = update.callback_query;
  const from = callback?.from ?? message?.from;
  const chat = callback?.message?.chat ?? message?.chat;
  if (!from || from.is_bot || !chat) return { ...NOTHING, outcome: "ignored_shape" };
  const chatId = String(chat.id);

  // Reporting commands in private chats only. A group gets one sentence and
  // no reporting surface at all, so nothing about a team can be echoed into
  // a room the team did not choose.
  if (chat.type && chat.type !== "private") {
    return {
      replies: message ? [{ chatId, text: BOT_COPY.privateOnly, keyboard: [] }] : [],
      answer: callback ? { callbackQueryId: callback.id, text: BOT_COPY.privateOnly } : null,
      queued: false,
      outcome: "not_private",
    };
  }

  const actor = await telegramMemberActor(String(from.id), db);
  if (!actor) {
    const connect = hqLink(hqOrigin, ACCOUNT_PATH);
    return {
      replies: [{ chatId, text: BOT_COPY.notConnected, keyboard: [openHqButton(connect, LABELS.connect)].filter((row) => row.length) }],
      answer: callback ? { callbackQueryId: callback.id } : null,
      queued: false,
      outcome: "not_connected",
    };
  }

  const session: Session = { db, now, actor, chatId, hqOrigin, updateId: update.update_id, hackathonId: null, retry: context.retry ?? false };
  await bindBotChat(db, { userId: actor.id, telegramUserId: String(from.id), chatId });

  // Permission to be messaged, read now rather than remembered. The one thing
  // that gets through without it is the button that grants it.
  const consented = await botMessagingEnabled(db, actor.id);
  if (!consented) {
    const pressedEnable = callback ? await enableConsentPress(session, callback) : null;
    if (pressedEnable) return pressedEnable;
    const enable = await button(session, LABELS.enableMessages, { kind: "consent.enable" });
    return {
      replies: [{ chatId, text: BOT_COPY.messagingOff, keyboard: [[enable], openHqButton(hqLink(hqOrigin, ACCOUNT_PATH))].filter((row) => row.length) }],
      answer: callback ? { callbackQueryId: callback.id } : null,
      queued: false,
      outcome: "messaging_off",
    };
  }

  const isCaptain = (await getActorCapabilities(actor)).has("captain");
  if (message?.text && commandOf(message.text) === "/start") {
    const reply = isCaptain
      ? await mainMenu(session)
      : { chatId, keyboard: [openHqButton(hqLink(hqOrigin, "/hq/dashboard"))].filter((row) => row.length) };
    return {
      replies: [{ ...reply, text: BOT_COPY.remindersEnabled }],
      answer: null,
      queued: false,
      outcome: "started",
    };
  }

  // Captain access, read now as well: a grant revoked a minute ago closes the
  // bot on the next press, and the message says how to get access without
  // naming a single project.
  if (!isCaptain) {
    return {
      replies: [{ chatId, text: BOT_COPY.noCaptainAccess, keyboard: [openHqButton(hqLink(hqOrigin, CAPTAIN_PATH))].filter((row) => row.length) }],
      answer: callback ? { callbackQueryId: callback.id } : null,
      queued: false,
      outcome: "no_capability",
    };
  }

  if (callback) return handleCallback(session, callback);
  return handleMessage(session, message ?? {});
}

/** The consent button is the one press allowed before consent exists. Everything after it is the ordinary menu. */
async function enableConsentPress(session: Session, callback: TelegramCallbackQuery): Promise<BotOutcome | null> {
  const resolved = await readBotAction(session.db, { id: String(callback.data ?? ""), userId: session.actor.id, chatId: session.chatId }, session.now);
  if (!resolved.ok || resolved.action.kind !== "consent.enable") return null;
  // Not a claimed single-use press: `setBotConsent` is idempotent by
  // construction, so a double tap or a redelivery writes nothing the second
  // time and records nothing either.
  await setBotConsent(session.actor, true);
  const menu = await mainMenu(session, BOT_COPY.messagingOn);
  return {
    replies: [menu],
    answer: { callbackQueryId: callback.id },
    queued: false,
    outcome: "consent_enabled",
  };
}

/* -------------------------------------------------------------------------
 * Messages
 * ---------------------------------------------------------------------- */

const COMMANDS = new Set(["/start", "/menu", "/help", "/cancel"]);

/** The command word of a message, without the @botname Telegram appends in some clients. */
const commandOf = (text: string) => text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();

async function handleMessage(session: Session, message: TelegramMessage): Promise<BotOutcome> {
  const text = typeof message.text === "string" ? message.text : null;
  const draft = await readBotDraft(session.db, { userId: session.actor.id, chatId: session.chatId }, session.now);

  if (text && text.trim().startsWith("/")) {
    const command = commandOf(text);
    if (command === "/cancel") {
      await clearBotDraft(session.db, { userId: session.actor.id, chatId: session.chatId });
      return { replies: [await mainMenu(session, BOT_COPY.cancelled)], answer: null, queued: false, outcome: "cancelled" };
    }
    if (COMMANDS.has(command)) return { replies: [await mainMenu(session)], answer: null, queued: false, outcome: "menu" };
    return { replies: [await mainMenu(session)], answer: null, queued: false, outcome: "unknown_command" };
  }

  // The only step at which free text means anything. Outside it, a message is
  // not interpreted: the menu comes back instead.
  if (draft && session.retry && draft.step === "preview") {
    return { ...(await resumeDraft(session, draft)), answer: null };
  }
  if (!draft || draft.step !== "awaiting_text") {
    return { replies: [await mainMenu(session)], answer: null, queued: false, outcome: draft ? "menu_with_draft" : "menu" };
  }
  if (text === null) {
    return { replies: [{ chatId: session.chatId, text: BOT_COPY.attachmentIgnored, keyboard: [] }], answer: null, queued: false, outcome: "not_text" };
  }
  const body = text.trim();
  if (!body) return { replies: [{ chatId: session.chatId, text: BOT_COPY.composeEmpty, keyboard: [] }], answer: null, queued: false, outcome: "empty" };
  if (updateCharacterCount(body) > MAX_BODY_LENGTH) {
    return { replies: [{ chatId: session.chatId, text: BOT_COPY.composeTooLong, keyboard: [] }], answer: null, queued: false, outcome: "too_long" };
  }

  session.hackathonId = draft.hackathonId;
  const project = await projectFor(session, draft.projectId, draft.hackathonId);
  if (!project) return { ...(await staleReply(session, "stale_project")), answer: null };
  // Conditional on the generation this message was typed against, so two
  // messages arriving at once cannot both become the preview.
  const saved = await advanceBotDraft(
    session.db,
    { userId: session.actor.id, chatId: session.chatId, draftId: draft.id, expectedRevision: draft.revision, step: "preview", body },
    session.now,
  );
  if (!saved) return { ...(await staleReply(session, "stale_draft")), answer: null };
  return {
    replies: await previewReplies(session, saved, project.summary, project.mayUseSensitive),
    answer: null,
    queued: false,
    outcome: "preview",
  };
}

/* -------------------------------------------------------------------------
 * Button presses
 * ---------------------------------------------------------------------- */

/**
 * Resolve the callback now; consume it only inside the saving transaction so
 * a transient failure does not spend the button without completing its write.
 */
async function handleCallback(session: Session, callback: TelegramCallbackQuery): Promise<BotOutcome> {
  const resolved = await readBotAction(
    session.db,
    { id: String(callback.data ?? ""), userId: session.actor.id, chatId: session.chatId },
    session.now,
  );
  if (!resolved.ok) {
    // Already used covers the double tap and the redelivered press: the first
    // one did the work, the second says so and writes nothing.
    return {
      replies: [await mainMenu(session, BOT_COPY.staleAction)],
      answer: { callbackQueryId: callback.id },
      queued: false,
      outcome: `action_${resolved.reason}`,
    };
  }
  const result = await dispatch(session, resolved.action);
  return { ...result, answer: { callbackQueryId: callback.id } };
}

/**
 * Require both draft generation and revision: old previews cannot target another
 * team or change/save a newer revision of the same draft.
 */
async function boundDraft(session: Session, action: BotAction): Promise<BotDraft | null> {
  if (!action.draftId || action.draftRevision == null) return null;
  const draft = await readBotDraft(session.db, { userId: session.actor.id, chatId: session.chatId }, session.now);
  if (!draft || draft.id !== action.draftId || draft.revision !== action.draftRevision) return null;
  // A button that also names a project has to agree with the draft about
  // which one, so a reference cannot be pointed at a different team.
  if (action.projectId && action.projectId !== draft.projectId) return null;
  return draft;
}

type Dispatched = Omit<BotOutcome, "answer">;

async function dispatch(session: Session, action: BotAction): Promise<Dispatched> {
  // Scope the whole press to the edition the pressed button was minted for.
  session.hackathonId = action.hackathonId;

  // Every button that touches a draft is checked against the live draft
  // first, in one place, so no handler below can forget.
  if (isDraftAction(action.kind)) {
    const draft = await boundDraft(session, action);
    if (!draft) {
      // A quick second tap or a failed message edit can leave the visible
      // keyboard behind the draft. Restore the current preview, without
      // replaying an old Save or audience choice. A replaced draft stays dead.
      const current = await readBotDraft(session.db, { userId: session.actor.id, chatId: session.chatId }, session.now);
      if (current?.id === action.draftId && (!action.projectId || action.projectId === current.projectId)) {
        return resumeDraft(session, current, action.kind === "draft.preview" ? action.page : 0);
      }
      return staleReply(session, "stale_draft");
    }
    switch (action.kind) {
      case "draft.preview":
        return resumeDraft(session, draft, action.page);
      case "draft.review":
        return reviewDraft(session, draft, action);
      case "draft.rewrite":
        return rewriteDraft(session, draft);
      case "draft.visibility":
        return setDraftVisibility(session, action, draft);
      case "draft.cancel":
        if (!(await claimBotDraft(session.db, { userId: session.actor.id, chatId: session.chatId, draftId: draft.id, expectedRevision: draft.revision }, session.now))) {
          return staleReply(session, "stale_draft");
        }
        return { replies: [await mainMenu(session, BOT_COPY.cancelled)], queued: false, outcome: "cancelled" };
      case "draft.save":
        return save(session, action, draft, {});
      case "draft.save_into_current":
        return save(session, action, draft, { intoCurrentPeriod: true });
      case "draft.save_over":
        return save(session, action, draft, { overrideVersion: action.expectedVersion ?? undefined });
      default:
        return staleReply(session, "stale_draft");
    }
  }
  switch (action.kind) {
    case "menu":
      return { replies: [await mainMenu(session)], queued: false, outcome: "menu" };
    case "projects.page":
      return { replies: [await projectListReply(session, action.page, "open")], queued: false, outcome: "projects" };
    case "compose.page":
      return { replies: [await projectListReply(session, action.page, "compose")], queued: false, outcome: "compose_list" };
    case "project.open":
      return openProject(session, action);
    case "project.compose":
      return startCompose(session, action);
    case "notes.page":
      return ownNotes(session, action);
    case "note.open":
      return openOwnNote(session, action);
    case "note.edit":
      return startEdit(session, action);
    case "consent.enable":
      // Reached only when consent was already on, because the gate above
      // handles the other case. Nothing to do but show the menu.
      return { replies: [await mainMenu(session)], queued: false, outcome: "menu" };
    default:
      return { replies: [await mainMenu(session)], queued: false, outcome: "menu" };
  }
}

/**
 * Use the live Captain board, so reassigned projects are absent. Sensitive access
 * comes from authorizeProjectAction via captain, never the global capability alone.
 */
async function projectFor(
  session: Session,
  projectId: string | null,
  hackathonId?: number,
): Promise<{ card: CaptainReportingCard; summary: ProjectSummary; hackathonId: number; mayUseSensitive: boolean } | null> {
  if (!projectId) return null;
  const board = await loadBoard(session);
  if (!board) return null;
  if (hackathonId !== undefined && hackathonId !== board.hackathonId) return null;
  const card = board.cards.find((candidate) => candidate.status.projectId === projectId);
  if (!card) return null;
  const decision = await authorizeProjectAction(session.actor, { projectId, hackathonId: board.hackathonId, action: "update.create" });
  if (!decision.allowed) return null;
  return {
    card,
    summary: toSummary(card),
    hackathonId: board.hackathonId,
    mayUseSensitive: decision.via === "operator" || decision.via === "captain",
  };
}

const staleReply = async (session: Session, outcome: string): Promise<Dispatched> => ({
  replies: [await mainMenu(session, BOT_COPY.staleAction)],
  queued: false,
  outcome,
});

async function openProject(session: Session, action: BotAction): Promise<Dispatched> {
  const project = await projectFor(session, action.projectId);
  if (!project) return staleReply(session, "stale_project");
  return { replies: [await projectReply(session, project.card)], queued: false, outcome: "project" };
}

const composeHeader = (project: ProjectSummary): string => [
  `<b>${escapeHtml(snippet(project.projectName, 160))}</b>`,
  escapeHtml(weekLine(project.current)),
  "",
  escapeHtml(BOT_COPY.compose),
].join("\n");

/** The composer prompt, whose only control is a Cancel bound to the draft it was opened for. */
async function composePrompt(session: Session, draft: BotDraft, header: string, outcome: string): Promise<Dispatched> {
  const cancel = await draftButton(session, draft, LABELS.cancel, { kind: "draft.cancel" });
  return { replies: [{ chatId: session.chatId, text: header, keyboard: [[cancel]], newMessage: true }], queued: false, outcome };
}

async function startCompose(session: Session, action: BotAction): Promise<Dispatched> {
  if (session.retry) {
    const current = await readBotDraft(session.db, { userId: session.actor.id, chatId: session.chatId }, session.now);
    if (current) return resumeDraft(session, current);
  }
  const project = await projectFor(session, action.projectId);
  if (!project) return staleReply(session, "stale_project");
  // A NEW composing session, which retires every button the previous one
  // left in the chat. The draft is bound to the week that is open at this
  // instant, so a save that crosses midnight is caught by the reporting
  // service's own `expectedPeriodId` check rather than landing quietly in
  // another week.
  const draft = await startBotDraft(
    session.db,
    {
      userId: session.actor.id,
      chatId: session.chatId,
      step: "awaiting_text",
      projectId: project.summary.projectId,
      hackathonId: project.hackathonId,
      periodId: project.card.current?.periodId ?? null,
      entryId: null,
      expectedVersion: null,
      visibility: "shared",
      body: null,
    },
    session.now,
  );
  return composePrompt(session, draft, composeHeader(project.summary), "compose");
}

async function rewriteDraft(session: Session, draft: BotDraft): Promise<Dispatched> {
  const project = await projectFor(session, draft.projectId, draft.hackathonId);
  if (!project) return staleReply(session, "stale_project");
  const advanced = await advanceBotDraft(
    session.db,
    { userId: session.actor.id, chatId: session.chatId, draftId: draft.id, expectedRevision: draft.revision, step: "awaiting_text", body: null },
    session.now,
  );
  if (!advanced) return staleReply(session, "stale_draft");
  return composePrompt(session, advanced, composeHeader(project.summary), "compose");
}

/** Rebuild a draft's controls after a failed reply, while checking its current project access. */
async function resumeDraft(session: Session, draft: BotDraft, index = 0): Promise<Dispatched> {
  session.hackathonId = draft.hackathonId;
  const project = await projectFor(session, draft.projectId, draft.hackathonId);
  if (!project) return staleReply(session, "stale_project");
  if (draft.step === "awaiting_text") return composePrompt(session, draft, composeHeader(project.summary), "compose");
  return { replies: await previewReplies(session, draft, project.summary, project.mayUseSensitive, index), queued: false, outcome: "preview" };
}

/**
 * Store the requested audience on the action, making repeated presses idempotent.
 * Bind the draft revision so an old toggle cannot expose a different note.
 */
async function setDraftVisibility(session: Session, action: BotAction, draft: BotDraft): Promise<Dispatched> {
  const project = await projectFor(session, draft.projectId, draft.hackathonId);
  if (!project) return staleReply(session, "stale_project");
  const wanted = action.visibility ?? "shared";
  // Asked for, but not allowed on this project: a Captain posting as a member
  // of their own team comes back `via: "member"` and cannot hide an update
  // from their teammates. The service would refuse the save anyway; refusing
  // the toggle is the same rule, said earlier.
  const visibility = wanted === "sensitive" && !project.mayUseSensitive ? "shared" : wanted;
  const saved = await advanceBotDraft(
    session.db,
    { userId: session.actor.id, chatId: session.chatId, draftId: draft.id, expectedRevision: draft.revision, visibility },
    session.now,
  );
  if (!saved) {
    const current = await readBotDraft(session.db, { userId: session.actor.id, chatId: session.chatId }, session.now);
    if (current?.id === draft.id) return resumeDraft(session, current);
    return staleReply(session, "stale_draft");
  }
  if (saved.step !== "preview") return composePrompt(session, saved, composeHeader(project.summary), "compose");
  return { replies: await previewReplies(session, saved, project.summary, project.mayUseSensitive), queued: false, outcome: "preview" };
}

/**
 * Re-read through reporting authorization at the press. Revoked/reassigned or
 * non-editable entries are stale; a previously minted button grants no edit access.
 */
async function startEdit(session: Session, action: BotAction): Promise<Dispatched> {
  if (session.retry) {
    const current = await readBotDraft(session.db, { userId: session.actor.id, chatId: session.chatId }, session.now);
    if (current) return resumeDraft(session, current);
  }
  const project = await projectFor(session, action.projectId);
  if (!project || !action.entryId) return staleReply(session, "stale_project");
  const entry = await findEntry(session, project.summary.projectId, project.hackathonId, action.entryId);
  if (!entry || !entry.canEdit || !entry.authorIsYou) return staleReply(session, "stale_entry");
  const draft = await startBotDraft(
    session.db,
    {
      userId: session.actor.id,
      chatId: session.chatId,
      step: "awaiting_text",
      projectId: project.summary.projectId,
      hackathonId: project.hackathonId,
      periodId: entry.periodId,
      entryId: entry.id,
      expectedVersion: entry.version,
      visibility: entry.visibility,
      body: null,
    },
    session.now,
  );
  return composePrompt(session, draft, composeHeader(project.summary), "edit_compose");
}

/** One entry by id, through the service's current project and audience checks. */
async function findEntry(session: Session, projectId: string, hackathonId: number, entryId: string): Promise<ReportingEntryView | null> {
  const result = await readAuthorizedUpdates(session.actor, { projectId, hackathonId, entryId, limit: 1 }, session.db);
  return result.entries[0] ?? null;
}

/**
 * Read this account's own notes in the scoped edition, including after reassignment.
 * The author-only service returns read-only rows and restores no other team access.
 */
async function ownNotes(session: Session, action: BotAction): Promise<Dispatched> {
  const hackathonId = session.hackathonId ?? await builderStore().currentHackathonId();
  if (hackathonId === null) return { replies: [await mainMenu(session)], queued: false, outcome: "menu" };
  const own = await readOwnUpdates(
    session.actor,
    { hackathonId, limit: OWN_NOTES_PAGE, ...(action.cursor ? { cursor: action.cursor } : {}) },
    session.db,
  );
  const back = await button(session, LABELS.back, { kind: "menu" });
  if (!own.entries.length) {
    return {
      replies: [{ chatId: session.chatId, text: escapeHtml(BOT_COPY.noNotes), keyboard: [[back]] }],
      queued: false,
      outcome: "notes_empty",
    };
  }
  const lines = [`<b>${escapeHtml(BOT_COPY.notesTitle)}</b>`, escapeHtml(BOT_COPY.notesBody)];
  const rows: Keyboard = [];
  for (const entry of own.entries) {
    lines.push(
      "",
      `<b>${escapeHtml(snippet(entry.projectName, 60))}</b>${entry.visibility === "sensitive" ? escapeHtml(" (private)") : ""}`,
      `<blockquote>${escapeHtml(snippet(entry.body, 60))}</blockquote>`,
    );
    // Keep the full author-only note reachable after reassignment, not just its snippet.
    rows.push([await button(session, `${LABELS.read}: ${snippet(entry.body, 26)}`, { kind: "note.open", entryId: entry.id, projectId: entry.projectId })]);
  }
  if (own.nextCursor) {
    // Paged through the reporting service's own keyset cursor, so a long list
    // is read a page at a time rather than capped and re-read on every press.
    rows.push([await button(session, LABELS.next, { kind: "notes.page", cursor: own.nextCursor })]);
  }
  rows.push([back]);
  rows.push(openHqButton(hqLink(session.hqOrigin, CAPTAIN_PATH)));
  return { replies: [{ chatId: session.chatId, text: lines.join("\n"), keyboard: rows.filter((row) => row.length) }], queued: false, outcome: "notes" };
}

/**
 * Re-read the full note through current author-only access and live Captain capability.
 * Offer rewrite only when current project access and entry audience also allow it.
 */
async function openOwnNote(session: Session, action: BotAction): Promise<Dispatched> {
  const hackathonId = session.hackathonId ?? await builderStore().currentHackathonId();
  if (hackathonId === null || !action.entryId) return staleReply(session, "stale_entry");
  const note = await findOwnNote(session, hackathonId, action.entryId);
  if (!note) return staleReply(session, "stale_entry");
  const rows: Keyboard = [];
  const project = note.projectId ? await projectFor(session, note.projectId) : null;
  const editable = project ? await findEntry(session, project.summary.projectId, project.hackathonId, note.id) : null;
  if (editable?.canEdit && editable.authorIsYou) {
    rows.push([await button(session, LABELS.edit, { kind: "note.edit", projectId: project?.summary.projectId ?? null, entryId: note.id, expectedVersion: note.version })]);
  } else {
    rows.push([]);
  }
  rows.push([await button(session, LABELS.backToNotes, { kind: "notes.page" })]);
  rows.push(openHqButton(hqLink(session.hqOrigin, CAPTAIN_PATH)));
  const messages = ownNoteMessages({
    projectName: note.projectName,
    body: note.body,
    visibility: note.visibility,
    periodStart: note.periodStart,
    periodEnd: note.periodEnd,
    readOnly: !editable?.canEdit,
  });
  return {
    replies: await pagedReplies(session, messages, rows, action.page,
      (text, page) => button(session, text, { kind: "note.open", entryId: note.id, projectId: note.projectId, page })),
    queued: false,
    outcome: "note",
  };
}

/** One of the account's own notes by id, through the author-only service read. */
async function findOwnNote(
  session: Session,
  hackathonId: number,
  entryId: string,
): Promise<(OwnReportingEntry & { periodStart: string; periodEnd: string }) | null> {
  const result = await readOwnUpdates(session.actor, { hackathonId, entryId, limit: 1 }, session.db);
  const found = result.entries[0];
  if (!found) return null;
  const periods = await listReportingPeriods(session.db, hackathonId);
  const period = periods.find((candidate: ReportingPeriod) => candidate.id === found.periodId);
  return { ...found, periodStart: period?.startDate ?? "", periodEnd: period?.endDate ?? "" };
}

/* -------------------------------------------------------------------------
 * Saving
 * ---------------------------------------------------------------------- */

/**
 * Save only through createUpdate/editUpdate. Identity, project permission, expected
 * period and edit version are rechecked; period_changed/conflict preserve the draft
 * and require explicit review rather than silently moving or overwriting text.
 */
/** Why a save did not happen, carried out of the transaction so the rollback can precede the reply. */
class SaveAborted extends Error {
  constructor(readonly detail:
    | { kind: "stale" }
    | { kind: "period_changed"; currentPeriod: ReportingPeriod | null; body: string }
    | { kind: "conflict"; current: ReportingEntryView; body: string }
    | { kind: "refused"; reason: string; body: string; outcome: string }) {
    super("save aborted");
    this.name = "SaveAborted";
  }
}

async function save(
  session: Session,
  action: BotAction,
  draft: BotDraft,
  options: { intoCurrentPeriod?: boolean; overrideVersion?: number },
): Promise<Dispatched> {
  if (!draft.body) return staleReply(session, "stale_draft");
  // Read before the transaction, because these reads run on the pool and the
  // transaction must not wait on itself. They are a courtesy, not the
  // decision: `createUpdate` and `editUpdate` re-authorize inside the
  // transaction over the same handle they write through.
  const project = await projectFor(session, draft.projectId, draft.hackathonId);
  if (!project) return staleReply(session, "stale_project");

  try {
    return await session.db.transaction(async (tx) => {
      // The logical save, claimed twice over. The button is consumed here
      // rather than before, and the draft generation is claimed by deleting
      // it: two buttons that mean the same save, and two deliveries of one
      // button, all find one of these already taken. Because both commit with
      // the reporting write, an attempt that dies leaves neither taken and
      // Telegram's retry does the work properly.
      if (isWriteAction(action.kind) && !(await consumeBotAction(tx, { id: action.id, userId: session.actor.id, updateId: session.updateId }))) {
        throw new SaveAborted({ kind: "stale" });
      }
      const claimed = await claimBotDraft(tx, { userId: session.actor.id, chatId: session.chatId, draftId: draft.id, expectedRevision: draft.revision }, session.now);
      if (!claimed || !claimed.body) throw new SaveAborted({ kind: "stale" });

      const entry = claimed.entryId
        ? await saveEdit(session, claimed, options, tx)
        : await saveNew(session, claimed, options, tx);

      // The week as it stands after the write, read inside the same
      // transaction so the confirmation cannot describe a state that never
      // committed. An edit to an older entry completes nothing, and this is
      // what keeps the message honest about that.
      const [status] = await reportingStatus(tx, { hackathonId: claimed.hackathonId, projectIds: [claimed.projectId], atMs: session.now });
      const period = status?.current ?? null;
      const menuAction = await createBotAction(tx, {
        userId: session.actor.id, chatId: session.chatId, kind: "menu", hackathonId: claimed.hackathonId,
      }, session.now);
      const keyboard: Keyboard = [
        [{ text: LABELS.back, callbackId: menuAction.id }],
        openHqButton(hqLink(session.hqOrigin, CAPTAIN_PATH)),
      ].filter((row) => row.length);
      await enqueueBotMessage(tx, {
        chatId: session.chatId,
        userId: session.actor.id,
        kind: "update.saved",
        body: savedMessage(project.summary.projectName, period, Boolean(period?.completed)),
        replyMarkup: keyboard.length ? inlineKeyboard(keyboard) : null,
        dedupeKey: `entry:${entry.id}:v${entry.version}`,
        projectId: claimed.projectId,
        hackathonId: claimed.hackathonId,
      });
      // The buttons the preview left in the chat go with the draft they
      // belonged to, so the keyboard cannot be pressed again at all.
      await tx.query("DELETE FROM hq_telegram_actions WHERE user_id = $1 AND chat_id = $2::bigint AND draft_id = $3::uuid AND id <> $4::uuid",
        [session.actor.id, session.chatId, draft.id, action.id]);
      return { replies: [], queued: true, outcome: "saved" };
    });
  } catch (error) {
    if (!(error instanceof SaveAborted)) throw error;
    return abortReply(session, draft, error.detail);
  }
}

/** A new entry, or the refusal that stops the transaction and gives the draft back. */
async function saveNew(session: Session, draft: BotDraft, options: { intoCurrentPeriod?: boolean }, tx: BuilderQuery): Promise<ReportingEntryView> {
  const result = await createUpdate(
    session.actor,
    {
      projectId: draft.projectId,
      hackathonId: draft.hackathonId,
      body: draft.body ?? "",
      visibility: draft.visibility,
      source: "telegram",
      ...(options.intoCurrentPeriod ? {} : { expectedPeriodId: draft.periodId ?? undefined }),
      atMs: session.now,
    },
    tx,
  );
  if (result.ok) return result.entry;
  if (result.reason === "period_changed") {
    throw new SaveAborted({ kind: "period_changed", currentPeriod: result.currentPeriod ?? null, body: draft.body ?? "" });
  }
  throw new SaveAborted({ kind: "refused", reason: result.reason, body: draft.body ?? "", outcome: "create_refused" });
}

/** An edit of the author's own entry, or the refusal that stops the transaction and gives the draft back. */
async function saveEdit(session: Session, draft: BotDraft, options: { overrideVersion?: number }, tx: BuilderQuery): Promise<ReportingEntryView> {
  const result = await editUpdate(
    session.actor,
    {
      entryId: draft.entryId ?? "",
      body: draft.body ?? "",
      visibility: draft.visibility,
      expectedVersion: options.overrideVersion ?? draft.expectedVersion ?? 1,
      // Saving the preview explicitly confirms its displayed audience, including sharing.
      confirmAudienceChange: true,
    },
    tx,
  );
  if (result.ok) return result.entry;
  if (result.reason === "conflict" && result.current) {
    throw new SaveAborted({ kind: "conflict", current: result.current, body: draft.body ?? "" });
  }
  throw new SaveAborted({ kind: "refused", reason: result.reason, body: draft.body ?? "", outcome: "edit_refused" });
}

/**
 * Build refusal replies after rollback restores the draft and its exact generation.
 * Keep period_changed/conflict distinct, with the saved facts and unsaved text intact.
 */
async function abortReply(session: Session, draft: BotDraft, detail: SaveAborted["detail"], index = 0): Promise<Dispatched> {
  if (detail.kind === "stale") return staleReply(session, "stale_draft");
  const project = await projectFor(session, draft.projectId, draft.hackathonId);
  if (!project) return staleReply(session, "stale_project");
  const cancel = await draftButton(session, draft, LABELS.cancel, { kind: "draft.cancel" });
  const cursor = detail.kind === "refused" ? `${detail.outcome}:${detail.reason}` : detail.kind;
  const navigation = (text: string, page: number) => draftButton(session, draft, text, {
    kind: "draft.review", cursor, page, expectedVersion: detail.kind === "conflict" ? detail.current.version : null,
  });
  let messages: string[];
  let saveButton: Button | null = null;
  if (detail.kind === "period_changed") {
    if (detail.currentPeriod) {
      saveButton = await draftButton(session, draft, LABELS.saveIntoNewWeek, { kind: "draft.save_into_current", projectId: draft.projectId });
    }
    messages = periodChangedMessages(detail.currentPeriod, detail.body, project.summary.projectName);
  } else if (detail.kind === "conflict") {
    saveButton = await draftButton(session, draft, LABELS.saveAnyway, { kind: "draft.save_over", projectId: draft.projectId, expectedVersion: detail.current.version });
    messages = conflictMessages(detail.current.body, detail.body, project.summary.projectName);
  } else {
    messages = refusalMessages(reportingRefusal(detail.outcome === "create_refused" ? "create" : "edit", detail.reason, project.summary.projectName), detail.body, project.summary.projectName);
  }
  return {
    replies: await pagedReplies(session, messages, [[cancel]], index, navigation, saveButton ? [[saveButton]] : []),
    queued: false,
    outcome: detail.kind === "refused" ? detail.outcome : detail.kind,
  };
}

/** Paging a refused save only re-reads current facts. It never tries the write again. */
async function reviewDraft(session: Session, draft: BotDraft, action: BotAction): Promise<Dispatched> {
  const project = await projectFor(session, draft.projectId, draft.hackathonId);
  if (!project || draft.step !== "preview") return staleReply(session, "stale_draft");
  const body = draft.body ?? "";
  if (action.cursor === "period_changed") {
    const periods = await listReportingPeriods(session.db, draft.hackathonId);
    const currentPeriod = periods.find((period) => period.id === project.card.current?.periodId) ?? null;
    return abortReply(session, draft, { kind: "period_changed", currentPeriod, body }, action.page);
  }
  if (action.cursor === "conflict" && draft.entryId) {
    const current = await findEntry(session, draft.projectId, draft.hackathonId, draft.entryId);
    if (!current?.canEdit || !current.authorIsYou) return staleReply(session, "stale_entry");
    // If HQ saved again while the captain was reading, restart the review
    // so an overwrite never skips straight to the end of an unseen version.
    return abortReply(session, draft, { kind: "conflict", current, body }, action.expectedVersion === current.version ? action.page : 0);
  }
  const [outcome, reason] = (action.cursor ?? "").split(":");
  if ((outcome === "create_refused" || outcome === "edit_refused") && reason) {
    return abortReply(session, draft, { kind: "refused", outcome, reason, body }, action.page);
  }
  return staleReply(session, "stale_draft");
}
