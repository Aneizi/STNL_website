// The deterministic Telegram bot against the real schema on PGlite.
//
// Nothing about authorization, completion or visibility is mocked. The bot's
// only stubbed boundary is the Telegram transport, because the point of the
// phase is that HQ and the bot behave identically: every assertion below
// about who may do what, what completes a week and what a team can read is
// answered by `lib/hq/reporting.ts` and `lib/hq/authz.ts`, exactly as it is
// for the website's Server Actions.
//
// The identity boundary is not stubbed either. There is no session in a
// webhook, so the bot resolves an account from `hq_auth_telegram_identity`
// on every update; the tests seed and remove that row rather than pretending
// to be signed in.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ builderDatabase: vi.fn() }));
vi.mock("@/lib/hq/builder-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hq/builder-db")>()),
  builderDatabase: mocks.builderDatabase,
}));

import type { MemberActor } from "@/lib/hq/actor";
import type { BuilderDatabase } from "@/lib/hq/builder-db";
import { authorizeProjectAction } from "@/lib/hq/authz";
import { grantCapability, revokeCapability } from "@/lib/hq/capabilities";
import { assignCaptain, unassignCaptain } from "@/lib/hq/captains";
import {
  createUpdate,
  enableReporting,
  listReportingPeriods,
  readAuthorizedUpdates,
  reportingStatus,
} from "@/lib/hq/reporting";
import type { TelegramBotConfig, TelegramSender } from "@/lib/hq/telegram-bot-api";
import { handleTelegramUpdate, type BotOutcome, type TelegramUpdate } from "@/lib/hq/telegram-bot";
import { createBotAction, enqueueBotMessage, flushBotMessages, MAX_SEND_ATTEMPTS, readBotDraft } from "@/lib/hq/telegram-bot-store";
import { TELEGRAM_TEXT_LIMIT } from "@/lib/hq/telegram-bot-view";
import { setBotConsent } from "@/lib/hq/telegram-consent";
import { handleTelegramWebhookRequest, SECRET_HEADER } from "@/lib/hq/telegram-webhook";
import { createMigratedDatabase, pgliteBuilderDatabase } from "./helpers/db";

const OPERATOR = "00000000-0000-4000-8000-0000000000c1";
const EDITION = 81;
const PROJECT = "00000000-0000-4000-9200-000000000001";
const SECOND_PROJECT = "00000000-0000-4000-9200-000000000002";
const CAPTAIN = "captain-a";
const OTHER_CAPTAIN = "captain-b";
const LEAD = "lead-a";
const CAPTAIN_TELEGRAM = "7000000000111";
const LEAD_TELEGRAM = "7000000000222";
const CHAT = "7000000000111";

let pg: PGlite;
let db: BuilderDatabase;
let updateSeq = 1000;

async function rows(text: string, values: unknown[] = []) {
  return (await pg.query(text, values)).rows as Record<string, unknown>[];
}

/** One inbound text message, in a private chat, from a Telegram user. */
function messageUpdate(telegramUserId: string, text: string, options: { chatId?: string; chatType?: string } = {}): TelegramUpdate {
  updateSeq += 1;
  return {
    update_id: updateSeq,
    message: { message_id: updateSeq, chat: { id: options.chatId ?? telegramUserId, type: options.chatType ?? "private" }, from: { id: telegramUserId }, text },
  };
}

/** One inbound button press, carrying the opaque id the server minted. */
function callbackUpdate(telegramUserId: string, callbackId: string, options: { chatId?: string; chatType?: string } = {}): TelegramUpdate {
  updateSeq += 1;
  return {
    update_id: updateSeq,
    callback_query: {
      id: `cb-${updateSeq}`,
      from: { id: telegramUserId },
      data: callbackId,
      message: { message_id: updateSeq, chat: { id: options.chatId ?? telegramUserId, type: options.chatType ?? "private" } },
    },
  };
}

const HQ = "https://hq.example.test";
const run = (update: TelegramUpdate, now?: number) => handleTelegramUpdate(update, { db, hqOrigin: HQ, ...(now ? { now } : {}) });

/** Fictional, and shaped only so `telegramBotConfig`'s own validation would accept it. */
const BOT_CONFIG: TelegramBotConfig = {
  token: "1234567890:AAfictional-token-value-for-tests",
  webhookSecret: "a-fictional-webhook-secret-value",
  apiBase: "https://api.telegram.invalid",
};

/** A sender that records what it was asked to send, for the cases where the answer is "nothing". */
function countingSender() {
  const calls: string[] = [];
  const sender: TelegramSender = {
    async sendMessage(message) { calls.push(message.text); return { ok: true, messageId: calls.length }; },
    async answerCallbackQuery() {},
  };
  return { calls, sender };
}

/** The same update, as Telegram would actually deliver it. */
const webhookRequest = (update: TelegramUpdate) =>
  new Request("https://hq.example.test/api/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", [SECRET_HEADER]: BOT_CONFIG.webhookSecret },
    body: JSON.stringify(update),
  });

/** Every button in the reply, so a test can press one by its label. */
function buttons(outcome: BotOutcome): { text: string; callbackId?: string; url?: string }[] {
  return outcome.replies.flatMap((reply) => reply.keyboard.flat()).map((button) => ("url" in button ? { text: button.text, url: button.url } : { text: button.text, callbackId: button.callbackId }));
}

function buttonId(outcome: BotOutcome, label: string): string {
  const found = buttons(outcome).find((button) => button.text === label || button.text.startsWith(label));
  if (!found?.callbackId) throw new Error(`no button "${label}" in ${JSON.stringify(buttons(outcome))}`);
  return found.callbackId;
}

const allText = (outcome: BotOutcome) => outcome.replies.map((reply) => reply.text).join("\n");

/**
 * A button that is dead, however it died.
 *
 * Two mechanisms answer a press on a retired keyboard and the person sees the
 * same sentence either way: `action_not_found` when the row was deleted with
 * the draft it belonged to, `stale_draft` when the row survives but names a
 * draft generation that has moved on. Both are "that button is no longer
 * good"; which one applies is an implementation detail of when the sweep
 * happened, so the tests assert the guarantee rather than the mechanism.
 */
function expectDeadButton(outcome: BotOutcome) {
  expect(["stale_draft", "action_not_found", "action_already_used", "action_expired"]).toContain(outcome.outcome);
  expect(allText(outcome)).toContain("no longer good");
}

/** A member actor, for the few places a test writes through the service directly. */
const member = (id: string, capabilities: "captain"[] = []): MemberActor => ({
  kind: "member", id, name: id, email: null, capabilities: new Set(capabilities), telegram: null,
});

async function seedAccount(id: string, name: string) {
  await rows(`INSERT INTO hq_auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,true) ON CONFLICT (id) DO NOTHING`, [id, name, `${id}@example.test`]);
  await rows(`INSERT INTO hq_builder_profiles(id,email,name) VALUES($1,$2,$3) ON CONFLICT (id) DO NOTHING`, [id, `${id}@example.test`, name]);
}

async function connectTelegram(userId: string, telegramUserId: string) {
  await rows(
    `INSERT INTO hq_auth_account(id,issuer,"accountId","providerId","userId") VALUES($1,'https://oauth.telegram.org',$2,'telegram',$3)
     ON CONFLICT (id) DO UPDATE SET "accountId"=EXCLUDED."accountId"`,
    [`telegram-${userId}`, `tg-${telegramUserId}`, userId],
  );
  await rows(
    `INSERT INTO hq_auth_telegram_identity(user_id,provider_subject,telegram_user_id) VALUES($1,$2,$3::bigint)
     ON CONFLICT (user_id) DO UPDATE SET telegram_user_id = EXCLUDED.telegram_user_id`,
    [userId, `tg-${telegramUserId}`, telegramUserId],
  );
}

async function allowMessages(userId: string, telegramUserId: string, chatId = telegramUserId) {
  await rows(
    `INSERT INTO hq_telegram_bot_consent(user_id,telegram_user_id,messaging_enabled,consented_at,chat_id)
     VALUES($1,$2::bigint,true,now(),$3::bigint)
     ON CONFLICT (user_id) DO UPDATE SET messaging_enabled=true, consented_at=now(), chat_id=EXCLUDED.chat_id`,
    [userId, telegramUserId, chatId],
  );
}

async function seedProject(id: string, name: string, lead: string) {
  await rows(
    `INSERT INTO hq_projects(id,hackathon_id,name,status_id,forecast_id,last_check_in)
     SELECT $1,$2,$3,s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f LIMIT 1`,
    [id, EDITION, name],
  );
  await rows(
    `INSERT INTO hq_project_onboarding(project_id,hackathon_id,external_id,project_url,slug,raw,owner_user_id,verification,lead_username)
     VALUES($1,$2,$3,$4,$5,'{}',$6,'verified',$6)`,
    [id, EDITION, id.slice(-4), `https://colosseum.example.test/${id.slice(-4)}`, id.slice(-4), lead],
  );
  await rows(`INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at) VALUES($1,$2,$2,$2,now())`, [id, lead]);
  await enableReporting(db, { projectId: id, hackathonId: EDITION });
}

async function makeCaptain(userId: string, projectId?: string) {
  await grantCapability(db, { actor: { kind: "operator", id: OPERATOR }, byOperatorId: OPERATOR, userId, capability: "captain", reason: "test" });
  if (projectId) {
    const result = await assignCaptain(db, { actorOperatorId: OPERATOR, projectId, hackathonId: EDITION, captainUserId: userId });
    if (result.outcome !== "assigned") throw new Error(`could not assign: ${JSON.stringify(result)}`);
  }
}

/** Menu, pick the team, type the update, and stop at the preview. */
async function composeTo(projectName: string, text: string, options: { telegramUserId?: string; now?: number } = {}) {
  const telegramUserId = options.telegramUserId ?? CAPTAIN_TELEGRAM;
  const at = options.now;
  const menu = await run(messageUpdate(telegramUserId, "/start"), at);
  const list = await run(callbackUpdate(telegramUserId, buttonId(menu, "Add update")), at);
  const compose = await run(callbackUpdate(telegramUserId, buttonId(list, projectName)), at);
  const preview = await run(messageUpdate(telegramUserId, text), at);
  return { list, compose, preview };
}

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = pgliteBuilderDatabase(pg);
  mocks.builderDatabase.mockReturnValue(db);
  await rows(`INSERT INTO hq_users(id,username,display_name,password_hash) VALUES($1,'op','Operator','x')`, [OPERATOR]);
  await rows(`INSERT INTO hq_project_statuses(slug,label,color,counts_as_active,sort) VALUES('onboarding','Onboarding','accent',true,100)`);
  await rows(`INSERT INTO hq_project_forecasts(slug,label,color,sort) VALUES('unassessed','Not assessed','muted',100)`);
}, 40_000);

afterAll(async () => { await pg.close(); });

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.builderDatabase.mockReturnValue(db);
  await pg.exec(`
    DELETE FROM hq_telegram_outgoing; DELETE FROM hq_telegram_drafts; DELETE FROM hq_telegram_actions;
    DELETE FROM hq_telegram_updates; DELETE FROM hq_telegram_bot_consent; DELETE FROM hq_auth_telegram_identity;
    DELETE FROM hq_reporting_entry_revisions; DELETE FROM hq_reporting_entries; DELETE FROM hq_reporting_outcomes;
    DELETE FROM hq_reporting_pause_intervals; DELETE FROM hq_reporting_eligibility; DELETE FROM hq_reporting_periods;
    DELETE FROM hq_reporting_config; DELETE FROM hq_captain_assignments; DELETE FROM hq_account_capabilities;
    DELETE FROM hq_audit_events; DELETE FROM hq_project_members; DELETE FROM hq_project_onboarding;
    DELETE FROM hq_project_ownership; DELETE FROM hq_projects; DELETE FROM hq_builder_enrollments;
    DELETE FROM hq_people; DELETE FROM hq_crm_persons; DELETE FROM hq_builder_profiles; DELETE FROM hq_auth_user;
    DELETE FROM hq_settings; DELETE FROM hq_hackathons;
  `);
  await rows(`INSERT INTO hq_hackathons(id,slug,name,start_date,end_date) VALUES($1,'worlds-fair','Worlds Fair',current_date - 1, current_date + 27)`, [EDITION]);
  await seedAccount(LEAD, "Team Lead");
  await seedAccount(CAPTAIN, "Captain A");
  await seedAccount(OTHER_CAPTAIN, "Captain B");
  await seedProject(PROJECT, "Vault Team", LEAD);
  await seedProject(SECOND_PROJECT, "Bridge Team", LEAD);
  await makeCaptain(CAPTAIN, PROJECT);
  await connectTelegram(CAPTAIN, CAPTAIN_TELEGRAM);
  await allowMessages(CAPTAIN, CAPTAIN_TELEGRAM);
});

describe("identity binding", () => {
  it("tells an unconnected Telegram account how to connect, and shows it nothing else", async () => {
    const result = await run(messageUpdate("7000000000999", "/start"));
    expect(result.outcome).toBe("not_connected");
    expect(allText(result)).toContain("not connected to an HQ account yet");
    // No team, no week, no status: an unknown Telegram user learns nothing about HQ's contents.
    expect(allText(result)).not.toContain("Vault Team");
    expect(buttons(result).map((button) => button.url)).toEqual(["https://hq.example.test/hq/account"]);
  });

  it("resolves the account from the identity row, not from the payload", async () => {
    const result = await run(messageUpdate(CAPTAIN_TELEGRAM, "/start"));
    expect(result.outcome).toBe("menu");
    expect(allText(result)).toContain("Superteam NL HQ");
  });

  it("closes the bot the moment Telegram is unlinked, with nothing else to revoke", async () => {
    const menu = await run(messageUpdate(CAPTAIN_TELEGRAM, "/start"));
    const openList = buttonId(menu, "My projects");
    await rows("DELETE FROM hq_auth_telegram_identity WHERE user_id = $1", [CAPTAIN]);
    const after = await run(callbackUpdate(CAPTAIN_TELEGRAM, openList));
    expect(after.outcome).toBe("not_connected");
    expect(allText(after)).not.toContain("Vault Team");
  });

  it("refuses to work in a group chat and says so once", async () => {
    const result = await run(messageUpdate(CAPTAIN_TELEGRAM, "/start", { chatId: "-100200300", chatType: "supergroup" }));
    expect(result.outcome).toBe("not_private");
    expect(allText(result)).toContain("private chat");
    expect(allText(result)).not.toContain("Vault Team");
  });
});

describe("permissions", () => {
  it("asks for messaging permission before anything else, and grants it from the bot", async () => {
    await rows("UPDATE hq_telegram_bot_consent SET messaging_enabled = false WHERE user_id = $1", [CAPTAIN]);
    const asked = await run(messageUpdate(CAPTAIN_TELEGRAM, "/start"));
    expect(asked.outcome).toBe("messaging_off");
    expect(allText(asked)).not.toContain("Vault Team");

    const enabled = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(asked, "Turn on bot messages")));
    expect(enabled.outcome).toBe("consent_enabled");
    const [consent] = await rows("SELECT messaging_enabled, chat_id::text AS chat_id FROM hq_telegram_bot_consent WHERE user_id = $1", [CAPTAIN]);
    expect(consent.messaging_enabled).toBe(true);
    expect(consent.chat_id).toBe(CHAT);
  });

  it("explains how to get Captain access without naming a single project", async () => {
    await seedAccount("plain", "Plain Member");
    await connectTelegram("plain", LEAD_TELEGRAM);
    await allowMessages("plain", LEAD_TELEGRAM);
    const result = await run(messageUpdate(LEAD_TELEGRAM, "/start"));
    expect(result.outcome).toBe("no_capability");
    expect(allText(result)).toContain("Captain access");
    expect(allText(result)).not.toContain("Vault Team");
    expect(allText(result)).not.toContain("Bridge Team");
  });

  it("shows a Captain only their own assignments", async () => {
    await makeCaptain(OTHER_CAPTAIN, SECOND_PROJECT);
    const menu = await run(messageUpdate(CAPTAIN_TELEGRAM, "/start"));
    const list = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(menu, "My projects")));
    expect(allText(list)).toContain("Vault Team");
    expect(allText(list)).not.toContain("Bridge Team");
  });

  it("leaves website Captain access untouched when bot messaging is refused", async () => {
    await rows("UPDATE hq_telegram_bot_consent SET messaging_enabled = false WHERE user_id = $1", [CAPTAIN]);
    const decision = await authorizeProjectAction(
      { kind: "member", id: CAPTAIN, name: "Captain A", email: null, capabilities: new Set(["captain"]), telegram: null },
      { projectId: PROJECT, hackathonId: EDITION, action: "update.create" },
    );
    expect(decision).toEqual({ allowed: true, via: "captain" });
  });
});

describe("adding an update", () => {
  it("keeps composing and My notes in the edition named by the reminder", async () => {
    await rows("INSERT INTO hq_hackathons(id,slug,name,start_date,end_date) VALUES(82,'default-edition','Earlier edition',current_date-10,current_date+30)");
    const action = await createBotAction(db, { userId: CAPTAIN, chatId: CHAT, kind: "compose.page", hackathonId: EDITION });
    const list = await run(callbackUpdate(CAPTAIN_TELEGRAM, action.id));
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(list, "Vault Team")));
    const preview = await run(messageUpdate(CAPTAIN_TELEGRAM, "Text for the reminder's edition"));
    expect(preview.outcome).toBe("preview");
    expect((await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Save")))).outcome).toBe("saved");
    expect((await rows("SELECT p.hackathon_id FROM hq_reporting_entries e JOIN hq_reporting_periods p ON p.id=e.period_id"))[0].hackathon_id).toBe(EDITION);
    const notesAction = await createBotAction(db, { userId: CAPTAIN, chatId: CHAT, kind: "notes.page", hackathonId: EDITION });
    const notes = await run(callbackUpdate(CAPTAIN_TELEGRAM, notesAction.id));
    expect(allText(notes)).toContain("Text for the reminder");
    const opened = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(notes, "Read")));
    expect(opened.outcome).toBe("note");
  });
  it("saves through the same reporting service the website uses, and completes the week", async () => {
    const { preview } = await composeTo("Vault Team", "Met the team, shipping the swap flow this week.");
    expect(preview.outcome).toBe("preview");
    expect(allText(preview)).toContain("Met the team");
    expect(allText(preview)).toContain("Shared with the team");

    const saved = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Save")));
    expect(saved.outcome).toBe("saved");
    expect(saved.queued).toBe(true);

    const entries = await rows("SELECT body, source, visibility, author_kind, author_id FROM hq_reporting_entries");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: "telegram", visibility: "shared", author_kind: "member", author_id: CAPTAIN });
    expect(entries[0].body).toBe("Met the team, shipping the swap flow this week.");

    const [status] = await reportingStatus(db, { hackathonId: EDITION, projectIds: [PROJECT] });
    expect(status.current?.completed).toBe(true);
  });

  it("records one revision per save, exactly as an HQ save does", async () => {
    const { preview } = await composeTo("Vault Team", "First note.");
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Save")));
    const revisions = await rows("SELECT version, body FROM hq_reporting_entry_revisions ORDER BY version");
    expect(revisions).toEqual([{ version: 1, body: "First note." }]);
  });

  it("keeps the draft out of the entries table until Save is pressed", async () => {
    await composeTo("Vault Team", "Typed but not saved.");
    expect(await rows("SELECT id FROM hq_reporting_entries")).toHaveLength(0);
    const draft = await readBotDraft(db, { userId: CAPTAIN, chatId: CHAT });
    expect(draft).toMatchObject({ step: "preview", body: "Typed but not saved.", projectId: PROJECT });
  });

  it("throws the text away on Cancel and saves nothing", async () => {
    const { preview } = await composeTo("Vault Team", "Never mind.");
    const cancelled = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Cancel")));
    expect(cancelled.outcome).toBe("cancelled");
    expect(await readBotDraft(db, { userId: CAPTAIN, chatId: CHAT })).toBeNull();
    expect(await rows("SELECT id FROM hq_reporting_entries")).toHaveLength(0);
  });

  it("refuses an update longer than the service allows, and keeps the composer open", async () => {
    const menu = await run(messageUpdate(CAPTAIN_TELEGRAM, "/start"));
    const list = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(menu, "Add update")));
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(list, "Vault Team")));
    const tooLong = await run(messageUpdate(CAPTAIN_TELEGRAM, "x".repeat(4001)));
    expect(tooLong.outcome).toBe("too_long");
    const draft = await readBotDraft(db, { userId: CAPTAIN, chatId: CHAT });
    expect(draft?.step).toBe("awaiting_text");
  });

  it("does not read free text as a command outside the input step", async () => {
    const result = await run(messageUpdate(CAPTAIN_TELEGRAM, "add update for Vault Team"));
    expect(result.outcome).toBe("menu");
    expect(await rows("SELECT id FROM hq_reporting_entries")).toHaveLength(0);
  });
});

describe("sensitive notes", () => {
  it("packs a My notes page whose names and snippets expand during HTML escaping", async () => {
    await rows("UPDATE hq_projects SET name=$2 WHERE id=$1", [PROJECT, '"'.repeat(120)]);
    for (let index = 0; index < 4; index += 1) {
      const result = await createUpdate(member(CAPTAIN, ["captain"]), { projectId: PROJECT, hackathonId: EDITION, body: '"'.repeat(160), visibility: "shared", source: "hq" }, db);
      expect(result.ok).toBe(true);
    }
    const menu = await run(messageUpdate(CAPTAIN_TELEGRAM, "/start"));
    const notes = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(menu, "My notes")));
    expect(notes.replies.length).toBeGreaterThan(1);
    expect(notes.replies.every((reply) => reply.text.length <= TELEGRAM_TEXT_LIMIT)).toBe(true);
    expect(buttons(notes).filter((button) => button.text.startsWith("Read"))).toHaveLength(4);
  });
  it("offers the sensitive audience to the assigned Captain and saves it restricted", async () => {
    const { preview } = await composeTo("Vault Team", "The lead is stretched thin, I am watching it.");
    const marked = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Make it sensitive")));
    expect(allText(marked)).toContain("Kept between you and Superteam NL admins");
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(marked, "Save")));

    const entries = await rows("SELECT visibility FROM hq_reporting_entries");
    expect(entries).toEqual([{ visibility: "sensitive" }]);

    // The team sees the week as Updated and nothing of the note itself, in
    // SQL rather than in the interface: the service returns them nothing.
    const teamView = await readAuthorizedUpdates(
      { kind: "member", id: LEAD, name: "Team Lead", email: null, capabilities: new Set(), telegram: null },
      { projectId: PROJECT, hackathonId: EDITION },
      db,
    );
    expect(teamView.entries).toHaveLength(0);
    const [status] = await reportingStatus(db, { hackathonId: EDITION, projectIds: [PROJECT] });
    expect(status.current?.completed).toBe(true);
  });

  it("does not offer the sensitive audience on the Captain's own team", async () => {
    // The Captain is also on the roster of the team they captain elsewhere:
    // `authorizeProjectAction` answers `via: "member"`, so the global
    // capability cannot hide an update from their own teammates.
    await rows(`INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at) VALUES($1,$2,$2,$2,now())`, [PROJECT, CAPTAIN]);
    const { preview } = await composeTo("Vault Team", "Progress this week.");
    expect(buttons(preview).map((button) => button.text)).not.toContain("Make it sensitive");
  });

  it("lets the author read their own note after a reassignment, and nothing else of that team", async () => {
    const { preview } = await composeTo("Vault Team", "Quiet concern about the roadmap.");
    const marked = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Make it sensitive")));
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(marked, "Save")));
    // A team update the former Captain must NOT be able to reach afterwards.
    await createUpdate(
      { kind: "member", id: LEAD, name: "Team Lead", email: null, capabilities: new Set(), telegram: null },
      { projectId: PROJECT, hackathonId: EDITION, body: "Team side update." },
      db,
    );
    await unassignCaptain(db, { actorOperatorId: OPERATOR, projectId: PROJECT, hackathonId: EDITION });

    const menu = await run(messageUpdate(CAPTAIN_TELEGRAM, "/start"));
    const notes = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(menu, "My notes")));
    expect(notes.outcome).toBe("notes");
    expect(allText(notes)).toContain("Quiet concern about the roadmap");
    expect(allText(notes)).not.toContain("Team side update");
    // Read only: there is no button to rewrite it from here.
    expect(buttons(notes).map((button) => button.text)).not.toContain("Rewrite");

    const projects = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(menu, "My projects")));
    expect(allText(projects)).not.toContain("Vault Team");
  });

  it("opens one of the author's own notes in full after a reassignment, read only", async () => {
    // Longer than any snippet, so a list that only summarised it left
    // everything after the summary unreachable.
    const body = `${"A".repeat(300)} END_OF_NOTE`;
    const { preview } = await composeTo("Vault Team", body);
    const marked = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Make it sensitive")));
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(marked, "Save")));
    await unassignCaptain(db, { actorOperatorId: OPERATOR, projectId: PROJECT, hackathonId: EDITION });

    const menu = await run(messageUpdate(CAPTAIN_TELEGRAM, "/start"));
    const notes = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(menu, "My notes")));
    const opened = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(notes, "Read")));
    expect(opened.outcome).toBe("note");
    expect(allText(opened)).toContain("END_OF_NOTE");
    expect(allText(opened)).toContain("Sensitive.");
    // Read only: the team is not theirs any more, so there is no Rewrite.
    expect(buttons(opened).map((button) => button.text)).not.toContain("Rewrite");
    expect(allText(opened)).toContain("cannot be changed from here");
  });

  it("offers Rewrite from a note the Captain still holds the team for", async () => {
    const { preview } = await composeTo("Vault Team", "Still mine to change");
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Save")));
    const menu = await run(messageUpdate(CAPTAIN_TELEGRAM, "/start"));
    const notes = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(menu, "My notes")));
    const opened = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(notes, "Read")));
    expect(buttons(opened).map((button) => button.text)).toContain("Rewrite");
    expect((await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(opened, "Rewrite")))).outcome).toBe("edit_compose");
  });

  it("pages My notes on the reporting service's own cursor rather than a capped set", async () => {
    // More notes than one page holds, so the Next button has to carry a real
    // cursor instead of re-reading a fixed window.
    for (let index = 0; index < 7; index += 1) {
      await createUpdate(
        member(CAPTAIN, ["captain"]),
        { projectId: PROJECT, hackathonId: EDITION, body: `Note number ${index}` },
        db,
      );
    }
    const menu = await run(messageUpdate(CAPTAIN_TELEGRAM, "/start"));
    const first = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(menu, "My notes")));
    const second = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(first, "Next")));
    expect(second.outcome).toBe("notes");
    // A different page, not the same one again.
    expect(allText(second)).not.toBe(allText(first));
    const seen = new Set([...allText(first).matchAll(/Note number (\d)/g)].map((match) => match[1]));
    for (const match of allText(second).matchAll(/Note number (\d)/g)) expect(seen.has(match[1])).toBe(false);
  });

  it("shows another Captain nothing of a sensitive note, not even that it exists", async () => {
    const { preview } = await composeTo("Vault Team", "Only for admins.");
    const marked = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Make it sensitive")));
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(marked, "Save")));

    await connectTelegram(OTHER_CAPTAIN, LEAD_TELEGRAM);
    await allowMessages(OTHER_CAPTAIN, LEAD_TELEGRAM);
    await makeCaptain(OTHER_CAPTAIN, SECOND_PROJECT);
    const menu = await run(messageUpdate(LEAD_TELEGRAM, "/start"));
    const notes = await run(callbackUpdate(LEAD_TELEGRAM, buttonId(menu, "My notes")));
    expect(allText(notes)).not.toContain("Only for admins");
    const projects = await run(callbackUpdate(LEAD_TELEGRAM, buttonId(menu, "My projects")));
    expect(allText(projects)).not.toContain("Vault Team");
  });
});

describe("editing a note", () => {
  it("rewrites the author's own note through the edit flow, keeping its history", async () => {
    const { preview } = await composeTo("Vault Team", "First version.");
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Save")));

    const menu = await run(messageUpdate(CAPTAIN_TELEGRAM, "/start"));
    const list = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(menu, "My projects")));
    const project = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(list, "Vault Team")));
    const editing = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(project, "Rewrite")));
    expect(editing.outcome).toBe("edit_compose");

    const rewritten = await run(messageUpdate(CAPTAIN_TELEGRAM, "Second version."));
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(rewritten, "Save")));

    const entries = await rows("SELECT body, version FROM hq_reporting_entries");
    expect(entries).toEqual([{ body: "Second version.", version: 2 }]);
    const revisions = await rows("SELECT version, body FROM hq_reporting_entry_revisions ORDER BY version");
    expect(revisions).toEqual([
      { version: 1, body: "First version." },
      { version: 2, body: "Second version." },
    ]);
  });

  it("does not treat an edited Telegram message as an HQ edit", async () => {
    const { preview } = await composeTo("Vault Team", "As sent.");
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Save")));
    updateSeq += 1;
    const result = await handleTelegramUpdate(
      { update_id: updateSeq, edited_message: { chat: { id: CHAT, type: "private" }, from: { id: CAPTAIN_TELEGRAM }, text: "Rewritten in the client." } },
      { db, hqOrigin: "https://hq.example.test" },
    );
    expect(result.outcome).toBe("ignored_edit");
    expect(await rows("SELECT body, version FROM hq_reporting_entries")).toEqual([{ body: "As sent.", version: 1 }]);
  });

  it("hands back the version that is saved now when the edit lost a race, and keeps the unsaved text", async () => {
    const { preview } = await composeTo("Vault Team", "Mine, version one.");
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Save")));
    const menu = await run(messageUpdate(CAPTAIN_TELEGRAM, "/start"));
    const list = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(menu, "My projects")));
    const project = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(list, "Vault Team")));
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(project, "Rewrite")));
    const typed = await run(messageUpdate(CAPTAIN_TELEGRAM, "My Telegram rewrite."));

    // The website saves over it first, exactly the case the plan names.
    const [entry] = await rows("SELECT id::text AS id FROM hq_reporting_entries");
    await rows("UPDATE hq_reporting_entries SET body = $2, version = 2 WHERE id = $1::uuid", [entry.id, "Saved from HQ."]);

    const conflict = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(typed, "Save")));
    expect(conflict.outcome).toBe("conflict");
    expect(allText(conflict)).toContain("Saved from HQ.");
    expect(allText(conflict)).toContain("My Telegram rewrite.");

    const again = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(conflict, "Save over the current version")));
    expect(again.outcome).toBe("saved");
    expect(await rows("SELECT body FROM hq_reporting_entries")).toEqual([{ body: "My Telegram rewrite." }]);
  });
});

describe("a draft whose week closed under it", () => {
  it("names the week that is open now, keeps the text, and moves it only when asked", async () => {
    const periods = await listReportingPeriods(db, EDITION);
    expect(periods.length).toBeGreaterThan(1);
    // Written five minutes before the first week ends, saved a minute after
    // the second one began: the real shape of the case, and inside the
    // draft's own lifetime rather than a contrived week-old button.
    const boundary = Date.parse(periods[1].startsAt);
    const { preview } = await composeTo("Vault Team", "Written just before midnight.", { now: boundary - 5 * 60_000 });
    // The draft is bound to the week it was opened in.
    expect((await readBotDraft(db, { userId: CAPTAIN, chatId: CHAT }, boundary - 5 * 60_000))?.periodId).toBe(periods[0].id);

    const refused = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Save")), boundary + 60_000);
    expect(refused.outcome).toBe("period_changed");
    expect(allText(refused)).toContain("Written just before midnight.");
    expect(allText(refused)).toContain("The week that is open now runs");
    expect(await rows("SELECT id FROM hq_reporting_entries")).toHaveLength(0);

    const moved = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(refused, "Save into the week that is open now")), boundary + 60_000);
    expect(moved.outcome).toBe("saved");
    const [saved] = await rows("SELECT period_id::text AS period_id FROM hq_reporting_entries");
    expect(saved.period_id).toBe(periods[1].id);
  });
});

describe("duplicate deliveries and stale actions", () => {
  it("saves once when Save is pressed twice", async () => {
    const { preview } = await composeTo("Vault Team", "Pressed twice.");
    const save = buttonId(preview, "Save");
    const first = await run(callbackUpdate(CAPTAIN_TELEGRAM, save));
    const second = await run(callbackUpdate(CAPTAIN_TELEGRAM, save));
    expect(first.outcome).toBe("saved");
    expect(second.outcome).toBe("action_already_used");
    expect(await rows("SELECT id FROM hq_reporting_entries")).toHaveLength(1);
    expect(await rows("SELECT version FROM hq_reporting_entry_revisions")).toHaveLength(1);
  });

  it("queues exactly one confirmation for one save", async () => {
    const { preview } = await composeTo("Vault Team", "One confirmation.");
    const save = buttonId(preview, "Save");
    await run(callbackUpdate(CAPTAIN_TELEGRAM, save));
    await run(callbackUpdate(CAPTAIN_TELEGRAM, save));
    const queued = await rows("SELECT kind, body, dedupe_key FROM hq_telegram_outgoing");
    expect(queued).toHaveLength(1);
    expect(String(queued[0].kind)).toBe("update.saved");
  });

  it("never writes an update body into the outgoing queue", async () => {
    const { preview } = await composeTo("Vault Team", "A sentence that must not be stored twice.");
    const marked = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Make it sensitive")));
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(marked, "Save")));
    const queued = await rows("SELECT body FROM hq_telegram_outgoing");
    expect(queued).toHaveLength(1);
    expect(String(queued[0].body)).not.toContain("must not be stored twice");
    expect(String(queued[0].body)).toContain("Updated");
  });

  it("lets a navigation button be pressed again, because the keyboard stays in the chat", async () => {
    const menu = await run(messageUpdate(CAPTAIN_TELEGRAM, "/start"));
    const projects = buttonId(menu, "My projects");
    expect((await run(callbackUpdate(CAPTAIN_TELEGRAM, projects))).outcome).toBe("projects");
    expect((await run(callbackUpdate(CAPTAIN_TELEGRAM, projects))).outcome).toBe("projects");
  });

  it("refuses a button minted for another account", async () => {
    await connectTelegram(OTHER_CAPTAIN, LEAD_TELEGRAM);
    await allowMessages(OTHER_CAPTAIN, LEAD_TELEGRAM);
    await makeCaptain(OTHER_CAPTAIN, SECOND_PROJECT);
    const menu = await run(messageUpdate(CAPTAIN_TELEGRAM, "/start"));
    const theirs = buttonId(menu, "My projects");
    const stolen = await run(callbackUpdate(LEAD_TELEGRAM, theirs));
    expect(stolen.outcome).toBe("action_not_found");
    expect(allText(stolen)).not.toContain("Vault Team");
  });

  it("fails a stale project button after the assignment moved to someone else", async () => {
    const menu = await run(messageUpdate(CAPTAIN_TELEGRAM, "/start"));
    const list = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(menu, "My projects")));
    const open = buttonId(list, "Vault Team");
    await makeCaptain(OTHER_CAPTAIN);
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: PROJECT, hackathonId: EDITION, captainUserId: OTHER_CAPTAIN });
    const stale = await run(callbackUpdate(CAPTAIN_TELEGRAM, open));
    expect(stale.outcome).toBe("stale_project");
    expect(allText(stale)).not.toContain("Vault Team");
  });

  it("leaves a draft pointing at a deleted project harmless rather than in the way", async () => {
    await composeTo("Vault Team", "Written before the team was removed.");
    await rows("DELETE FROM hq_projects WHERE id = $1::uuid", [PROJECT]);
    // The draft row survives the deletion on purpose: it has no key into
    // hq_projects, so a Delete team confirmation stays about the team's own
    // records. What it cannot do is reach anything.
    const draft = await readBotDraft(db, { userId: CAPTAIN, chatId: CHAT });
    expect(draft?.projectId).toBe(PROJECT);
    const menu = await run(messageUpdate(CAPTAIN_TELEGRAM, "/start"));
    const list = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(menu, "My projects")));
    expect(allText(list)).toContain("no teams assigned");
  });

  it("takes the account's bot state with the account", async () => {
    await composeTo("Vault Team", "Mid sentence.");
    expect(await rows("SELECT user_id FROM hq_telegram_drafts")).toHaveLength(1);
    await rows("DELETE FROM hq_builder_profiles WHERE id = $1", [CAPTAIN]);
    expect(await rows("SELECT user_id FROM hq_telegram_drafts")).toHaveLength(0);
    expect(await rows("SELECT id FROM hq_telegram_actions")).toHaveLength(0);
    expect(await rows("SELECT user_id FROM hq_telegram_bot_consent")).toHaveLength(0);
  });

  it("refuses a save whose Captain capability was revoked while the draft was open", async () => {
    const { preview } = await composeTo("Vault Team", "Written before the revocation.");
    await revokeCapability(db, { actor: { kind: "operator", id: OPERATOR }, byOperatorId: OPERATOR, userId: CAPTAIN, capability: "captain", reason: "test" });
    const refused = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Save")));
    expect(refused.outcome).toBe("no_capability");
    expect(await rows("SELECT id FROM hq_reporting_entries")).toHaveLength(0);
  });

  it("lets an expired draft go rather than saving stale text", async () => {
    const { preview } = await composeTo("Vault Team", "Left overnight.");
    const save = buttonId(preview, "Save");
    await rows("UPDATE hq_telegram_drafts SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [CAPTAIN]);
    const result = await run(callbackUpdate(CAPTAIN_TELEGRAM, save));
    expect(result.outcome).toBe("stale_draft");
    expect(await rows("SELECT id FROM hq_reporting_entries")).toHaveLength(0);
  });

  it("refuses an expired button", async () => {
    const menu = await run(messageUpdate(CAPTAIN_TELEGRAM, "/start"));
    const projects = buttonId(menu, "My projects");
    await rows("UPDATE hq_telegram_actions SET expires_at = now() - interval '1 minute'");
    const result = await run(callbackUpdate(CAPTAIN_TELEGRAM, projects));
    expect(result.outcome).toBe("action_expired");
  });
});

describe("a button belongs to one draft, and to one state of it", () => {
  it("refuses Save from a preview whose draft was replaced by another team's", async () => {
    await makeCaptain(CAPTAIN, SECOND_PROJECT);
    const vault = await composeTo("Vault Team", "Original Vault update");
    await composeTo("Bridge Team", "New Bridge update");

    // The Vault preview is still in the chat. Pressing its Save used to save
    // the Bridge draft, because the button meant "the current draft".
    const pressed = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(vault.preview, "Save")));
    expectDeadButton(pressed);
    expect(await rows("SELECT id FROM hq_reporting_entries")).toHaveLength(0);
  });

  it("saves once when two previews of one draft are both saved", async () => {
    const { preview } = await composeTo("Vault Team", "Single logical update");
    // Changing the audience re-renders the preview, so there are now two Save
    // buttons in the chat for one logical update.
    const sensitive = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Make it sensitive")));
    const [first, second] = await Promise.all([
      run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Save"))),
      run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(sensitive, "Save"))),
    ]);
    const [saved, dead] = first.outcome === "saved" ? [first, second] : [second, first];
    expect(saved.outcome).toBe("saved");
    expectDeadButton(dead);
    expect(await rows("SELECT id FROM hq_reporting_entries")).toHaveLength(1);
    expect(await rows("SELECT version FROM hq_reporting_entry_revisions")).toHaveLength(1);
  });

  it("does not let an old Share button re-open a different draft's sensitive note", async () => {
    await makeCaptain(CAPTAIN, SECOND_PROJECT);
    const original = await composeTo("Vault Team", "Original note");
    const oldSensitive = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(original.preview, "Make it sensitive")));
    const second = await composeTo("Bridge Team", "Sensitive Bridge information");
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(second.preview, "Make it sensitive")));

    const stale = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(oldSensitive, "Share it with the team")));
    expectDeadButton(stale);
    // The Bridge note is still sensitive. It used to be quietly shared.
    expect(await readBotDraft(db, { userId: CAPTAIN, chatId: CHAT })).toMatchObject({ visibility: "sensitive", projectId: SECOND_PROJECT });
  });

  it("refuses a Cancel left over from a replaced draft rather than discarding the new one", async () => {
    await makeCaptain(CAPTAIN, SECOND_PROJECT);
    const vault = await composeTo("Vault Team", "First");
    const bridge = await composeTo("Bridge Team", "Second");
    const stale = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(vault.preview, "Cancel")));
    expectDeadButton(stale);
    expect(await readBotDraft(db, { userId: CAPTAIN, chatId: CHAT })).toMatchObject({ body: "Second" });
    // And the current Cancel still works.
    expect((await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(bridge.preview, "Cancel")))).outcome).toBe("cancelled");
  });

  it("retires the whole preview keyboard once the draft is saved", async () => {
    const { preview } = await composeTo("Vault Team", "Saved and done");
    const rewrite = buttonId(preview, "Rewrite");
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Save")));
    // Rewrite belonged to a draft that no longer exists, and its row is gone
    // with it, so the keyboard cannot be used to resurrect anything.
    expectDeadButton(await run(callbackUpdate(CAPTAIN_TELEGRAM, rewrite)));
  });
});

describe("one transaction around a save", () => {
  it("rebuilds the text preview and Save controls after its Telegram send fails", async () => {
    const menu = await run(messageUpdate(CAPTAIN_TELEGRAM, "/start"));
    const list = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(menu, "Add update")));
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(list, "Vault Team")));
    const update = messageUpdate(CAPTAIN_TELEGRAM, "Keep this draft and its controls");
    const refusing: TelegramSender = { sendMessage: async () => ({ ok: false, retryable: true, code: "telegram_500", detail: null }), answerCallbackQuery: async () => {} };
    expect((await handleTelegramWebhookRequest(webhookRequest(update), { db, config: BOT_CONFIG, sender: refusing })).status).toBe(502);
    const sent: Parameters<TelegramSender["sendMessage"]>[0][] = [];
    const sender: TelegramSender = { sendMessage: async (message) => { sent.push(message); return { ok: true, messageId: 1 }; }, answerCallbackQuery: async () => {} };
    const retry = await handleTelegramWebhookRequest(webhookRequest(update), { db, config: BOT_CONFIG, sender });
    expect(retry.status).toBe(200);
    expect(sent.some((message) => message.text.includes("Keep this draft and its controls"))).toBe(true);
    const keyboard = sent.at(-1)?.replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
    const save = keyboard.inline_keyboard.flat().find((button) => button.text === "Save");
    expect(save).toBeDefined();
    expect((await run(callbackUpdate(CAPTAIN_TELEGRAM, save!.callback_data))).outcome).toBe("saved");
  });

  it("rebuilds changed visibility after a failed preview without applying the toggle twice", async () => {
    const { preview } = await composeTo("Vault Team", "Keep the sensitive audience");
    const update = callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Make it sensitive"));
    const refusing: TelegramSender = { sendMessage: async () => ({ ok: false, retryable: true, code: "telegram_500", detail: null }), answerCallbackQuery: async () => {} };
    expect((await handleTelegramWebhookRequest(webhookRequest(update), { db, config: BOT_CONFIG, sender: refusing })).status).toBe(502);
    const sender = countingSender();
    const retry = await handleTelegramWebhookRequest(webhookRequest(update), { db, config: BOT_CONFIG, sender: sender.sender });
    expect(retry.body).toMatchObject({ outcome: "preview" });
    expect(await readBotDraft(db, { userId: CAPTAIN, chatId: CHAT })).toMatchObject({ visibility: "sensitive", revision: 3 });
    expect(sender.calls.join("\n")).toContain("Keep the sensitive audience");
  });
  /**
   * A handle that fails the first query matching `fragment`, INSIDE the
   * transaction as well as outside it.
   *
   * Wrapping the transaction's own handle is the point: the save's callback
   * consumption, draft claim, reporting write and durable confirmation all
   * run on that handle now, so an injector that only wraps the pool cannot
   * reach any of them.
   */
  function faultOn(fragment: string): BuilderDatabase {
    let fired = false;
    const guard = async (text: string) => {
      if (!fired && text.includes(fragment)) {
        fired = true;
        throw new Error("Injected transient database failure");
      }
    };
    return {
      query: async (text, values) => {
        await guard(text);
        return db.query(text, values);
      },
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            query: async (text, values) => {
              await guard(text);
              return tx.query(text, values);
            },
          }),
        ),
    };
  }

  it("rolls the entry back when the durable confirmation cannot be written", async () => {
    const { preview } = await composeTo("Vault Team", "Atomic save and confirmation");
    const save = buttonId(preview, "Save");
    const failing = faultOn("INSERT INTO hq_telegram_outgoing");
    await expect(handleTelegramUpdate(callbackUpdate(CAPTAIN_TELEGRAM, save), { db: failing, hqOrigin: HQ })).rejects.toThrow();

    // The state the plan rules out: an update saved and nothing that was ever
    // going to say so. Both sides of the save are one transaction, so neither
    // survives alone.
    expect(await rows("SELECT id FROM hq_reporting_entries")).toHaveLength(0);
    expect(await rows("SELECT id FROM hq_telegram_outgoing")).toHaveLength(0);
    // And the person's words are still there, because the draft claim rolled
    // back with everything else.
    expect(await readBotDraft(db, { userId: CAPTAIN, chatId: CHAT })).toMatchObject({ body: "Atomic save and confirmation" });
    // As is the button, so Telegram's retry of the same press works.
    expect(await rows("SELECT consumed_at FROM hq_telegram_actions WHERE id = $1::uuid", [save])).toEqual([{ consumed_at: null }]);
  });

  it("rolls the entry back when the reporting write itself fails", async () => {
    const { preview } = await composeTo("Vault Team", "Never reached the entry table");
    const failing = faultOn("INSERT INTO hq_reporting_entry_revisions");
    await expect(
      handleTelegramUpdate(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Save")), { db: failing, hqOrigin: HQ }),
    ).rejects.toThrow();
    expect(await rows("SELECT id FROM hq_reporting_entries")).toHaveLength(0);
    expect(await rows("SELECT version FROM hq_reporting_entry_revisions")).toHaveLength(0);
  });

  it("finishes the save on Telegram's retry after an interrupted attempt", async () => {
    const { preview } = await composeTo("Vault Team", "Must survive a transient error");
    const save = buttonId(preview, "Save");
    const update = callbackUpdate(CAPTAIN_TELEGRAM, save);
    const failing = faultOn("INSERT INTO hq_telegram_outgoing");
    const sent: string[] = [];
    const sender: TelegramSender = {
      async sendMessage(message) { sent.push(message.text); return { ok: true, messageId: 1 }; },
      async answerCallbackQuery() {},
    };

    const first = await handleTelegramWebhookRequest(webhookRequest(update), { db: failing, config: BOT_CONFIG, sender, hqOrigin: HQ });
    expect(first.status).toBe(500);
    expect(await rows("SELECT id FROM hq_reporting_entries")).toHaveLength(0);

    // Telegram redelivers the identical update. It has to complete: the first
    // attempt committed nothing, so there is nothing to duplicate, and
    // refusing here is what lost the update for good.
    const retry = await handleTelegramWebhookRequest(webhookRequest(update), { db, config: BOT_CONFIG, sender, hqOrigin: HQ });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ ok: true, outcome: "saved" });
    const entries = await rows("SELECT body FROM hq_reporting_entries");
    expect(entries).toEqual([{ body: "Must survive a transient error" }]);
    expect(sent.some((text) => text.includes("Saved to"))).toBe(true);
  });
});

describe("escaping and delivery", () => {
  it("claims only what it can send within the invocation deadline", async () => {
    await run(messageUpdate(CAPTAIN_TELEGRAM, "/start"));
    for (let index = 0; index < 4; index += 1) {
      await enqueueBotMessage(db, { chatId: CHAT, userId: CAPTAIN, kind: "test", body: `message ${index}` });
    }
    const base = Date.now();
    let wall = base;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => wall);
    try {
      const sender: TelegramSender = { sendMessage: async () => { wall += 7_000; return { ok: true, messageId: 1 }; }, answerCallbackQuery: async () => {} };
      expect(await flushBotMessages(db, sender, { deadlineMs: base + 20_000 })).toMatchObject({ sent: 2, stoppedOnBudget: true });
      const queued = await rows("SELECT attempts, claimed_by FROM hq_telegram_outgoing WHERE state='queued'");
      expect(queued).toHaveLength(2);
      expect(queued.every((row) => row.attempts === 0 && row.claimed_by === null)).toBe(true);
    } finally { clock.mockRestore(); }
  });

  it("resolves a final delivery attempt interrupted by worker death as uncertain", async () => {
    const id = await enqueueBotMessage(db, { chatId: CHAT, userId: CAPTAIN, kind: "test", body: "Unknown delivery" });
    await rows("UPDATE hq_telegram_outgoing SET attempts=$2, claimed_by='dead-worker', claim_expires_at=now()-interval '1 second' WHERE id=$1", [id, MAX_SEND_ATTEMPTS]);
    const sender = countingSender();
    expect(await flushBotMessages(db, sender.sender)).toMatchObject({ failed: 1 });
    expect(sender.calls).toHaveLength(0);
    expect((await rows("SELECT state,last_error FROM hq_telegram_outgoing WHERE id=$1", [id]))[0]).toMatchObject({ state: "failed", last_error: expect.stringContaining("network:") });
  });

  it("measures retry_after from Telegram's response, after the request latency", async () => {
    await run(messageUpdate(CAPTAIN_TELEGRAM, "/start"));
    await enqueueBotMessage(db, { chatId: CHAT, userId: CAPTAIN, kind: "test", body: "Rate limited" });
    const base = Date.now();
    let wall = base;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => wall);
    try {
      const sender: TelegramSender = { sendMessage: async () => { wall += 5_000; return { ok: false, retryable: true, code: "telegram_429", detail: null, retryAfterSeconds: 30 }; }, answerCallbackQuery: async () => {} };
      await flushBotMessages(db, sender, { limit: 1 });
      const [queued] = await rows("SELECT next_attempt_at FROM hq_telegram_outgoing");
      expect((queued.next_attempt_at as Date).getTime()).toBe(base + 35_000);
    } finally { clock.mockRestore(); }
  });

  it("stops delivery when provider unlink succeeded but identity cleanup did not", async () => {
    const { preview } = await composeTo("Vault Team", "Saved before unlink");
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Save")));
    await rows('DELETE FROM hq_auth_account WHERE "userId"=$1', [CAPTAIN]);
    const sender = countingSender();
    await flushBotMessages(db, sender.sender);
    expect(sender.calls).toHaveLength(0);
    expect((await rows("SELECT skip_reason FROM hq_telegram_outgoing"))[0].skip_reason).toBe("telegram_disconnected");
  });

  it("does not deliver account history after its recipient account is deleted", async () => {
    const { preview } = await composeTo("Vault Team", "Saved before account deletion");
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Save")));
    await rows("DELETE FROM hq_builder_profiles WHERE id=$1", [CAPTAIN]);
    const sender = countingSender();
    await flushBotMessages(db, sender.sender);
    expect(sender.calls).toHaveLength(0);
    expect((await rows("SELECT state,skip_reason FROM hq_telegram_outgoing"))[0]).toMatchObject({ state: "skipped", skip_reason: "telegram_disconnected" });
  });
  it("escapes markup in a project name and in a note body", async () => {
    await rows("UPDATE hq_projects SET name = $2 WHERE id = $1::uuid", [PROJECT, "<b>Vault</b> & Co"]);
    const menu = await run(messageUpdate(CAPTAIN_TELEGRAM, "/start"));
    const list = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(menu, "Add update")));
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(list, "<b>Vault</b> & Co")));
    const preview = await run(messageUpdate(CAPTAIN_TELEGRAM, "Shipped <script>alert(1)</script> today"));
    const text = allText(preview);
    expect(text).toContain("&lt;b&gt;Vault&lt;/b&gt; &amp; Co");
    expect(text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(text).not.toContain("<script>");
  });

  it("sends the queued confirmation and records the provider message id", async () => {
    const { preview } = await composeTo("Vault Team", "Delivered.");
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Save")));
    const sent: { chatId: string; text: string }[] = [];
    const result = await flushBotMessages(db, {
      async sendMessage(message) {
        sent.push({ chatId: message.chatId, text: message.text });
        return { ok: true, messageId: 4242 };
      },
      async answerCallbackQuery() {},
    });
    expect(result).toEqual({ sent: 1, failed: 0, retrying: 0, skipped: 0 });
    expect(sent[0].chatId).toBe(CHAT);
    const [row] = await rows("SELECT state, provider_message_id::text AS provider_message_id FROM hq_telegram_outgoing");
    expect(row).toMatchObject({ state: "sent", provider_message_id: "4242" });
  });

  it("stops retrying a blocked bot and keeps Telegram's own words for an operator only", async () => {
    const { preview } = await composeTo("Vault Team", "Blocked.");
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Save")));
    const result = await flushBotMessages(db, {
      async sendMessage() {
        return { ok: false, retryable: false, code: "telegram_403", detail: "Forbidden: bot was blocked by the user" };
      },
      async answerCallbackQuery() {},
    });
    expect(result).toEqual({ sent: 0, failed: 1, retrying: 0, skipped: 0 });
    const [row] = await rows("SELECT state, skip_reason, last_error FROM hq_telegram_outgoing");
    expect(row).toMatchObject({ state: "skipped", skip_reason: "telegram_403" });
    expect(String(row.last_error)).toContain("blocked");
    // The entry is still there: a blocked bot never unsaves an update, and
    // never touches website access.
    expect(await rows("SELECT id FROM hq_reporting_entries")).toHaveLength(1);
  });

  it("keeps every message it actually sends inside Telegram's limit, and loses nothing of a long note", async () => {
    // A thousand ampersands: each escapes to five characters, so the preview
    // is well over one message. It used to be sliced in the transport, which
    // cut an entity in half and took the audience line with it.
    const body = "&".repeat(1000);
    const menu = await run(messageUpdate(CAPTAIN_TELEGRAM, "/start"));
    const list = await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(menu, "Add update")));
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(list, "Vault Team")));

    const sent: string[] = [];
    const sender: TelegramSender = {
      async sendMessage(message) {
        // The transport refuses an over-length message rather than corrupting
        // it, so anything the view got wrong shows up here as a failure.
        if (message.text.length > TELEGRAM_TEXT_LIMIT) return { ok: false, retryable: false, code: "message_too_long", detail: null };
        sent.push(message.text);
        return { ok: true, messageId: sent.length };
      },
      async answerCallbackQuery() {},
    };
    const result = await handleTelegramWebhookRequest(
      webhookRequest(messageUpdate(CAPTAIN_TELEGRAM, body)),
      { db, config: BOT_CONFIG, sender, hqOrigin: HQ },
    );
    expect(result.status).toBe(200);
    expect(sent.length).toBeGreaterThan(1);
    const joined = sent.join("");
    // Every ampersand survived, whole, and the audience is still stated.
    expect((joined.match(/&amp;/g) ?? []).length).toBe(1000);
    expect(joined).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#39;)/);
    expect(joined).toContain("Shared with the team");
  });

  it("does not deliver a queued message after the person turns bot messages off", async () => {
    const { preview } = await composeTo("Vault Team", "Saved before opting out");
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Save")));
    await setBotConsent({ kind: "member", id: CAPTAIN }, false);

    const sender = countingSender();
    const result = await flushBotMessages(db, sender.sender);
    expect(sender.calls).toHaveLength(0);
    expect(result).toMatchObject({ skipped: 1, sent: 0 });
    const [row] = await rows("SELECT state, skip_reason FROM hq_telegram_outgoing");
    expect(row).toMatchObject({ state: "skipped", skip_reason: "messaging_disabled" });
    // The update itself is untouched: refusing messages is not undoing work.
    expect(await rows("SELECT id FROM hq_reporting_entries")).toHaveLength(1);
  });

  it("does not deliver a queued message after Telegram is unlinked", async () => {
    const { preview } = await composeTo("Vault Team", "Saved before unlinking");
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Save")));
    await rows("DELETE FROM hq_auth_telegram_identity WHERE user_id = $1", [CAPTAIN]);
    const sender = countingSender();
    await flushBotMessages(db, sender.sender);
    expect(sender.calls).toHaveLength(0);
    expect((await rows("SELECT skip_reason FROM hq_telegram_outgoing"))[0]).toMatchObject({ skip_reason: "telegram_disconnected" });
  });

  it("does not deliver a queued message into a chat the person has moved on from", async () => {
    const { preview } = await composeTo("Vault Team", "Saved in the old chat");
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Save")));
    // A relink, or simply a fresh chat with the bot.
    await rows("UPDATE hq_telegram_bot_consent SET chat_id = 7000000000999 WHERE user_id = $1", [CAPTAIN]);
    const sender = countingSender();
    await flushBotMessages(db, sender.sender);
    expect(sender.calls).toHaveLength(0);
    expect((await rows("SELECT skip_reason FROM hq_telegram_outgoing"))[0]).toMatchObject({ skip_reason: "chat_changed" });
  });

  it("does not deliver a queued message about a project that has been reassigned", async () => {
    const { preview } = await composeTo("Vault Team", "Saved before the handover");
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Save")));
    await makeCaptain(OTHER_CAPTAIN);
    await assignCaptain(db, { actorOperatorId: OPERATOR, projectId: PROJECT, hackathonId: EDITION, captainUserId: OTHER_CAPTAIN });
    const sender = countingSender();
    await flushBotMessages(db, sender.sender);
    expect(sender.calls).toHaveLength(0);
    expect((await rows("SELECT skip_reason FROM hq_telegram_outgoing"))[0]).toMatchObject({ skip_reason: "not_authorized" });
  });

  it("sends one message per row when two drains run at once", async () => {
    const { preview } = await composeTo("Vault Team", "One confirmation only");
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Save")));
    let inFlight = 0;
    let overlapped = false;
    const calls: string[] = [];
    const sender: TelegramSender = {
      async sendMessage(message) {
        inFlight += 1;
        if (inFlight > 1) overlapped = true;
        calls.push(message.text);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return { ok: true, messageId: calls.length };
      },
      async answerCallbackQuery() {},
    };
    // The claim is what divides the queue between them. Without it both
    // drains selected the same row and both sent it.
    await Promise.all([flushBotMessages(db, sender), flushBotMessages(db, sender)]);
    expect(calls).toHaveLength(1);
    expect(overlapped).toBe(false);
  });

  it("waits for the retry_after Telegram asked for instead of trying again at once", async () => {
    const { preview } = await composeTo("Vault Team", "Rate limited");
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Save")));
    const base = Date.now();
    const limited: TelegramSender = {
      async sendMessage() { return { ok: false, retryable: true, code: "telegram_429", detail: "Too Many Requests", retryAfterSeconds: 30 }; },
      async answerCallbackQuery() {},
    };
    expect(await flushBotMessages(db, limited, { now: base })).toMatchObject({ retrying: 1 });
    const sender = countingSender();
    // Still inside the window Telegram named: nothing is attempted.
    await flushBotMessages(db, sender.sender, { now: base + 10_000 });
    expect(sender.calls).toHaveLength(0);
    // Past it: attempted again.
    await flushBotMessages(db, sender.sender, { now: base + 31_000 });
    expect(sender.calls).toHaveLength(1);
  });

  it("keeps a timed-out send queued rather than calling it delivered or failed", async () => {
    const { preview } = await composeTo("Vault Team", "Uncertain.");
    await run(callbackUpdate(CAPTAIN_TELEGRAM, buttonId(preview, "Save")));
    const result = await flushBotMessages(db, {
      async sendMessage() {
        return { ok: false, retryable: true, code: "timeout", detail: null };
      },
      async answerCallbackQuery() {},
    });
    expect(result).toEqual({ sent: 0, failed: 0, retrying: 1, skipped: 0 });
    const [row] = await rows("SELECT state, attempts FROM hq_telegram_outgoing");
    expect(row).toMatchObject({ state: "queued", attempts: 1 });
  });
});
