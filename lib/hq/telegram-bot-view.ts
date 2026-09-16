/**
 * Everything the Telegram bot says, and how it says it.
 *
 * Pure and client-safe like `lib/hq/reporting-view.ts`: no `server-only`, no
 * database handle, no session. `tests/hq/telegram-bot-view.test.ts` scans the
 * strings here for em dashes and middots, the same scan the reporting screens
 * are under, so the plan's copy rule keeps covering the bot.
 *
 * Reporting words are NOT redefined here. A week's dates, the two status
 * words, what each audience means and what each refusal from the reporting
 * service means all come from `reporting-view.ts`, so the bot and the website
 * cannot end up describing the same week differently. What this module adds
 * is the chat around them: menus, prompts, previews and keyboards.
 *
 * Two rules the plan sets and this module is where they are met:
 *
 * - **Escape Telegram formatting.** Every message goes out with
 *   `parse_mode: "HTML"` and every interpolated value passes through
 *   `escapeHtml` first, so a project name or an update body containing
 *   markup is shown as the characters somebody typed rather than parsed.
 *   Nothing here concatenates an unescaped value into a message.
 * - **A callback identifier is an opaque reference.** The keyboards below
 *   carry an id the server minted and bound to one account, one chat and one
 *   operation. No callback_data encodes a project, an entry or an intent, so
 *   a value edited in a client is a miss rather than an instruction.
 */

import {
  ADD_UPDATE_MESSAGES,
  AUDIENCE_NOTES,
  deadlineLabel,
  EDIT_UPDATE_MESSAGES,
  missedLabel,
  periodRangeLabel,
  statusLabel,
} from "./reporting-view";

export { ADD_UPDATE_MESSAGES, AUDIENCE_NOTES, EDIT_UPDATE_MESSAGES } from "./reporting-view";

/** How many projects or notes one menu page holds before it needs Previous and Next. */
export const PAGE_SIZE = 6;

/** How much of a note is shown in a list row. A full body needs its own message, not a button label. */
const SNIPPET = 60;

/**
 * The five characters Telegram's HTML parser reads. Applied to every
 * interpolated value without exception, including values that came from
 * Colosseum, from a teammate and from the person's own keyboard.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * One line of a note in a list: enough to recognise it, never the whole
 * thing. `length` is the length of the RESULT, ellipsis included, because a
 * button label and a list row are both budgets rather than suggestions.
 */
export function snippet(body: string, length = SNIPPET): string {
  const flat = String(body ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= length) return flat;
  return `${flat.slice(0, Math.max(0, length - 3)).trimEnd()}...`;
}

/**
 * Telegram's own cap on one message. Applied here, at the view, because this
 * is the only layer that knows where a message may be cut: the transport sees
 * a serialized HTML string and cannot tell an entity from a tag from a
 * sentence, so slicing there corrupts both the markup and the meaning.
 *
 * The limit is on the text after entity parsing, so measuring the escaped
 * string is a conservative over-estimate: a message this module calls full is
 * always shorter than Telegram's real limit, never longer.
 */
export const TELEGRAM_TEXT_LIMIT = 4096;

const OPEN_QUOTE = "<blockquote>";
const CLOSE_QUOTE = "</blockquote>";

/** A piece of a message: either markup this module wrote, or a body somebody typed and which may be split. */
export type MessagePart = { fixed: string } | { quote: string };

/**
 * Splits a plain string into pieces whose ESCAPED length fits `budget`.
 *
 * Chunking before escaping is what makes a split safe: an entity such as
 * `&amp;` is produced whole from one source character, so no chunk boundary
 * can ever fall inside one. Iteration is by code point, so an emoji or any
 * other surrogate pair stays intact, and a cut prefers the last space in the
 * second half of the chunk so a line breaks between words where it can.
 */
export function chunkForEscaped(plain: string, budget: number): string[] {
  const characters = Array.from(String(plain ?? ""));
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  const flush = () => {
    if (!current.length) return;
    const text = current.join("");
    const space = text.lastIndexOf(" ");
    // Break between words, but never throw away more than a quarter of a
    // chunk to do it.
    if (space > text.length * 0.75) {
      // Keep the boundary space: callers reassemble unsent chunks, and a
      // split must never turn two words into one.
      chunks.push(text.slice(0, space + 1));
      current = Array.from(text.slice(space + 1));
      length = current.reduce((total, character) => total + escapeHtml(character).length, 0);
      return;
    }
    chunks.push(text);
    current = [];
    length = 0;
  };
  for (const character of characters) {
    const cost = escapeHtml(character).length;
    if (length + cost > budget) flush();
    current.push(character);
    length += cost;
  }
  if (current.length) chunks.push(current.join(""));
  return chunks.length ? chunks : [""];
}

/**
 * Packs parts into as few whole messages as fit the limit, splitting a quoted
 * body across messages when it has to.
 *
 * Every message that comes out is complete and correctly escaped on its own:
 * every `<blockquote>` it opens it closes, and the fixed parts that follow a
 * body, the audience line above all, always survive. A preview that said
 * "Shared with the team" and then lost that line to a slice is precisely the
 * failure this exists to stop.
 */
export function packMessages(parts: readonly MessagePart[], limit = TELEGRAM_TEXT_LIMIT): string[] {
  const messages: string[] = [];
  let current = "";
  const room = () => limit - current.length - (current ? 1 : 0);
  const flush = () => {
    if (current) messages.push(current);
    current = "";
  };
  const append = (piece: string) => {
    current = current ? `${current}\n${piece}` : piece;
  };
  for (const part of parts) {
    if ("fixed" in part) {
      const piece = part.fixed;
      if (piece.length > limit) {
        // A fixed part is markup this module wrote around short values, so
        // this is unreachable in practice; splitting on lines rather than
        // throwing keeps it honest if a value ever grows.
        flush();
        for (const line of piece.split("\n")) {
          if (line.length > room()) flush();
          append(line.slice(0, limit));
        }
        continue;
      }
      if (piece.length > room()) flush();
      append(piece);
      continue;
    }
    const overhead = OPEN_QUOTE.length + CLOSE_QUOTE.length;
    // Try to finish the body in the message already open; otherwise start a
    // fresh one and chunk against the whole limit.
    if (room() - overhead < 40) flush();
    let budget = room() - overhead;
    let remaining = part.quote;
    while (remaining) {
      const [chunk, ...rest] = chunkForEscaped(remaining, Math.max(1, budget));
      append(`${OPEN_QUOTE}${escapeHtml(chunk)}${CLOSE_QUOTE}`);
      remaining = rest.join("");
      if (remaining) {
        flush();
        budget = limit - overhead;
      }
    }
  }
  flush();
  return messages.length ? messages : [""];
}

export type CallbackButton = { text: string; callbackId: string };
export type LinkButton = { text: string; url: string };
export type Button = CallbackButton | LinkButton;
export type Keyboard = Button[][];

/** Telegram's inline keyboard shape, built here so the transport carries no formatting rules of its own. */
export function inlineKeyboard(rows: Keyboard): { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] } {
  return {
    inline_keyboard: rows
      .map((row) =>
        row.map((button) =>
          "url" in button ? { text: button.text, url: button.url } : { text: button.text, callback_data: button.callbackId },
        ),
      )
      .filter((row) => row.length > 0),
  };
}

export type BotMessage = { text: string; keyboard: Keyboard };

/** The words for each menu action, in one place so a button and the message it leads to agree. */
export const LABELS = {
  myProjects: "My projects",
  addUpdate: "Add update",
  myNotes: "My notes",
  openHq: "Open HQ",
  connect: "Connect to HQ",
  back: "Back to menu",
  backToProject: "Back to the project",
  previous: "Previous",
  next: "Next",
  save: "Save",
  edit: "Rewrite",
  read: "Read",
  cancel: "Cancel",
  markSensitive: "Make it sensitive",
  markShared: "Share it with the team",
  saveIntoNewWeek: "Save into the week that is open now",
  saveAnyway: "Save over the current version",
  enableMessages: "Turn on bot messages",
} as const;

/** How many outstanding teams one reminder names before the rest are counted instead of listed. */
export const REMINDER_PROJECT_LIMIT = 20;

/**
 * The bot's own copy. Everything reporting already has words for is imported
 * rather than restated, so this list is only what a chat needs.
 */
export const BOT_COPY = {
  privateOnly: "I only handle reporting in a private chat. Message me directly and I will pick up from there.",
  notConnected:
    "Welcome to Superteam NL HQ.\n\nThis Telegram account is not connected to an HQ account yet. Open HQ, sign in, and connect Telegram from your account page. Then send me /start again.",
  noHqAccountLink: "Open HQ to sign in and connect Telegram, then send me /start again.",
  messagingOff:
    "Your HQ account is connected.\n\nBefore I can work with you here, turn on bot messages. That is the permission that lets Superteam NL reach you in Telegram, and you can turn it off again at any time from your HQ account page.",
  messagingOn: "Bot messages are on. You can turn them off again from your HQ account page at any time.",
  noCaptainAccess:
    "Your HQ account is connected.\n\nThis bot is for Captains, and your account does not have Captain access yet. Superteam NL grants it, either directly or through an invitation link. Ask in the Superteam NL Telegram group and someone will sort it out. Everything else in HQ keeps working in the meantime.",
  menuTitle: "Superteam NL HQ",
  menuBody: "Pick what you want to do.",
  noProjects:
    "You have no teams assigned right now. When Superteam NL assigns you one it will show up here, and nothing is needed from you before then.",
  projectsTitle: "Your teams",
  chooseProject: "Pick a team to add an update to.",
  compose: "Send your update as one message. Plain text, no attachments.",
  composeTooLong: "That is longer than an update can be. Shorten it and send it again.",
  composeEmpty: "That came through empty. Send the text of your update.",
  attachmentIgnored: "I can only read plain text here. Send your update as a message.",
  previewTitle: "Here is what will be saved.",
  cancelled: "Nothing was saved. The text is gone.",
  draftExpired: "That draft is too old, so I let it go. Start again from the menu and your team will be there.",
  staleAction:
    "That button is no longer good. Things may have changed since the message it came from, so start again from the menu.",
  noNotes: "You have not written any notes yet. Add one from a team above and it will show up here.",
  notesTitle: "Your notes",
  notesBody: "These are the notes you wrote. Pick one to read it in full.",
  noteReadOnly:
    "This note is yours to read, but the team is not assigned to you any more, so it cannot be changed from here.",
  unknownCommand: "I did not recognise that. Use the menu below.",
  saveFailed: "I could not save that. The text is below so you do not lose it. Try again in a moment.",
  hqUnavailable: "HQ is not reachable from here right now. Try again in a moment.",
  // The Wednesday reminder (phase 8). It names teams and a deadline and
  // nothing else: no update text, no note, no audience word, because a
  // notification reaches a chat whose contents HQ does not control.
  reminderTitle: "Weekly update reminder",
  reminderLead: "These teams still need this week's update:",
  reminderTail: "Add an update here, or open HQ.",
} as const;

/** The "Open HQ" button, or nothing when no public origin is configured. A button with no address is not offered. */
export function openHqButton(hqUrl: string | null, text: string = LABELS.openHq): Button[] {
  return hqUrl ? [{ text, url: hqUrl }] : [];
}

/** The state of one week as the bot names it: the dates, the deadline and the one status word. */
export function weekLine(period: { startDate: string; endDate: string; completed: boolean } | null): string {
  if (!period) return "There is no open reporting week right now.";
  return `Week of ${periodRangeLabel(period.startDate, period.endDate)}. Due ${deadlineLabel(period.endDate)}. ${statusLabel(period.completed)}.`;
}

export type ProjectSummary = {
  projectId: string;
  projectName: string;
  current: { startDate: string; endDate: string; completed: boolean } | null;
  missedPeriods: number;
};

/** A project's line in a list: the name, whether this week is done, and how many weeks it has missed. */
export function projectListLine(project: ProjectSummary): string {
  const status = project.current ? statusLabel(project.current.completed) : "Not in weekly reporting yet";
  const missed = missedLabel(project.missedPeriods);
  return `${escapeHtml(project.projectName)}\n${escapeHtml(missed ? `${status}. ${missed}.` : `${status}.`)}`;
}

/** A project's own screen: which week it is, where it stands, and what can be done about it. */
export function projectMessage(project: ProjectSummary, contact: string | null): string {
  const lines = [`<b>${escapeHtml(project.projectName)}</b>`, escapeHtml(weekLine(project.current))];
  const missed = missedLabel(project.missedPeriods);
  if (missed) lines.push(escapeHtml(`${missed} so far.`));
  if (contact) lines.push(escapeHtml(`Team contact: ${contact}`));
  return lines.join("\n");
}

/** A project name as a heading, capped so a very long one cannot crowd out the rest of a message. */
const heading = (name: string) => `<b>${escapeHtml(snippet(name, 160))}</b>`;

/** What each audience means, as the preview says it. */
export const audienceLine = (visibility: "shared" | "sensitive"): string =>
  visibility === "sensitive" ? `Sensitive. ${AUDIENCE_NOTES.sensitive}` : `Shared. ${AUDIENCE_NOTES.shared}`;

/**
 * The preview: the text as it will be saved, and who will be able to read it.
 * Said before the save, never after, and never lost to a truncation.
 *
 * Returns the messages to send in order. A note long enough to need two of
 * them keeps every word, and the audience line is still the last thing read
 * before Save, because the packer puts the fixed parts after the body in a
 * message of their own rather than dropping them.
 */
export function previewMessages(project: ProjectSummary, body: string, visibility: "shared" | "sensitive"): string[] {
  return packMessages([
    { fixed: `${heading(project.projectName)}\n${escapeHtml(weekLine(project.current))}\n\n${escapeHtml(BOT_COPY.previewTitle)}` },
    { quote: body },
    { fixed: escapeHtml(audienceLine(visibility)) },
  ]);
}

/** The confirmation, which is the one message that must survive a failed send: what was saved and what the week says now. */
export function savedMessage(projectName: string, period: { startDate: string; endDate: string } | null, completed: boolean): string {
  const week = period ? `Week of ${periodRangeLabel(period.startDate, period.endDate)}` : "This week";
  // Capped, because this is the one message that goes through the durable
  // queue, where an over-length row would be a permanent skip rather than a
  // second message.
  return `Saved to ${escapeHtml(snippet(projectName, 160))}.\n${escapeHtml(`${week} is now ${statusLabel(completed)}.`)}`;
}

/**
 * The two refusals that carry an answer rather than an apology.
 *
 * `period_changed` names the week that is open now and keeps the text, so the
 * person decides whether it belongs there. `conflict` shows the version that
 * is saved now beside the text they wrote, so neither is thrown away. Both
 * are the service's own wording from `reporting-view.ts` plus the fact the
 * chat needs in order to offer the button.
 */
export function periodChangedMessages(currentPeriod: { startDate: string; endDate: string } | null, body: string): string[] {
  const week = currentPeriod ? `The week that is open now runs ${periodRangeLabel(currentPeriod.startDate, currentPeriod.endDate)}.` : "There is no open week right now.";
  return packMessages([
    { fixed: `${escapeHtml(ADD_UPDATE_MESSAGES.period_changed)}\n${escapeHtml(week)}` },
    { quote: body },
  ]);
}

/** Both versions, in full. Two bodies can easily outrun one message, so they are packed rather than concatenated. */
export function conflictMessages(currentBody: string, yourBody: string): string[] {
  return packMessages([
    { fixed: escapeHtml(EDIT_UPDATE_MESSAGES.conflict) },
    { fixed: escapeHtml("Saved now:") },
    { quote: currentBody },
    { fixed: escapeHtml("Yours:") },
    { quote: yourBody },
  ]);
}

/** A refusal that keeps the text: the service's own wording, then the words somebody typed, in full. */
export function refusalMessages(message: string, body: string): string[] {
  return packMessages([{ fixed: escapeHtml(message) }, { quote: body }]);
}

/**
 * One of the author's own notes, in full.
 *
 * The author-only view, which is the only route to a note on a team the
 * account no longer holds, so it must not be a 220 character summary of
 * itself: everything after that was simply unreachable.
 */
export function ownNoteMessages(note: { projectName: string; body: string; visibility: "shared" | "sensitive"; periodStart: string; periodEnd: string }): string[] {
  return packMessages([
    {
      fixed: `${heading(note.projectName)}\n${escapeHtml(`Week of ${periodRangeLabel(note.periodStart, note.periodEnd)}.`)}\n${escapeHtml(audienceLine(note.visibility))}`,
    },
    { quote: note.body },
  ]);
}

export type ReminderView = {
  /** The edition's own name, so a Captain working two hackathons can tell which week this is. */
  editionName: string;
  period: { startDate: string; endDate: string };
  /** The outstanding teams, in the order they should be read. Names only. */
  projectNames: readonly string[];
};

/**
 * The Wednesday reminder, as one message.
 *
 * One message rather than a packed list, because this is the one kind of
 * message the durable queue carries for a reason that is not a save: it must
 * fit in a single row and a single send, so the team list is BOUNDED
 * (`REMINDER_PROJECT_LIMIT`) and each name is capped rather than allowed to
 * grow the body without limit. A Captain with more outstanding teams than
 * that is told how many are left and sent to HQ for the rest.
 *
 * What it carries is the plan's whole list: the edition, the week, the
 * deadline and the outstanding team names. No update body, no note, no
 * audience, no count of hidden notes and no status word other than the two
 * the rest of HQ already uses.
 */
export function reminderMessage(view: ReminderView): string {
  const shown = view.projectNames.slice(0, REMINDER_PROJECT_LIMIT);
  const rest = view.projectNames.length - shown.length;
  const week = `${view.editionName}. Week of ${periodRangeLabel(view.period.startDate, view.period.endDate)}. Due ${deadlineLabel(view.period.endDate)}.`;
  const lines = [
    `<b>${escapeHtml(snippet(BOT_COPY.reminderTitle, 80))}</b>`,
    escapeHtml(week),
    "",
    escapeHtml(BOT_COPY.reminderLead),
    ...shown.map((name) => escapeHtml(`- ${snippet(name, 80)}`)),
  ];
  if (rest > 0) lines.push(escapeHtml(rest === 1 ? "and 1 more, in HQ." : `and ${rest} more, in HQ.`));
  lines.push("", escapeHtml(BOT_COPY.reminderTail));
  return lines.join("\n");
}

/** One page of a list, and whether there is a page either side of it. */
export function page<T>(items: readonly T[], index: number, size = PAGE_SIZE): { items: T[]; index: number; hasPrevious: boolean; hasNext: boolean } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const clamped = Math.min(Math.max(0, Math.floor(index)), pages - 1);
  const start = clamped * size;
  return { items: items.slice(start, start + size), index: clamped, hasPrevious: clamped > 0, hasNext: start + size < items.length };
}
