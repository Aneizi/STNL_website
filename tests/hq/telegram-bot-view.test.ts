// The bot's presentation rules, which are pure and therefore assertable
// without a database, a token or a chat: escaping, the week line, the preview,
// the paging, and the copy scan.
//
// The copy scan is the plan's phase 6 acceptance bullet ("Interface copy
// contains no em dashes or middots") extended to the bot, so that the rule
// keeps covering every surface a person reads rather than only the screens.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ADD_UPDATE_MESSAGES,
  AUDIENCE_NOTES,
  BOT_COPY,
  conflictMessages,
  EDIT_UPDATE_MESSAGES,
  chunkForEscaped,
  escapeHtml,
  inlineKeyboard,
  LABELS,
  openHqButton,
  packMessages,
  page,
  periodChangedMessages,
  previewMessages,
  projectListLine,
  projectMessage,
  REMINDER_PROJECT_LIMIT,
  reminderMessage,
  savedMessage,
  snippet,
  TELEGRAM_TEXT_LIMIT,
  weekLine,
  type ProjectSummary,
} from "@/lib/hq/telegram-bot-view";

const WEEK = { startDate: "2026-09-14", endDate: "2026-09-20", completed: false };
const PROJECT: ProjectSummary = { projectId: "p1", projectName: "Vault Team", current: WEEK, missedPeriods: 0 };

describe("escaping", () => {
  it("preserves every space when a long note is split and packed", () => {
    const body = "One & two three four ".repeat(220);
    const chunks = chunkForEscaped(body, 80);
    expect(chunks.join("")).toBe(body);
    const messages = packMessages([{ quote: body }]);
    const quoted = messages.flatMap((message) => [...message.matchAll(/<blockquote>([\s\S]*?)<\/blockquote>/g)].map((match) => match[1])).join("");
    expect(quoted).toBe(escapeHtml(body));
    expect(messages.every((message) => message.length <= TELEGRAM_TEXT_LIMIT)).toBe(true);
  });
  it("escapes every character Telegram's HTML parser reads", () => {
    expect(escapeHtml(`<b>&"'`)).toBe("&lt;b&gt;&amp;&quot;&#39;");
  });

  it("escapes a name that came from Colosseum", () => {
    const line = projectListLine({ ...PROJECT, projectName: "<i>Zero</i> & One" });
    expect(line).toContain("&lt;i&gt;Zero&lt;/i&gt; &amp; One");
    expect(line).not.toContain("<i>");
  });

  it("escapes an update body in the preview, so nobody can format a message by typing one", () => {
    const text = previewMessages(PROJECT, "<b>URGENT</b> ping @everyone", "shared").join("\n");
    expect(text).toContain("&lt;b&gt;URGENT&lt;/b&gt;");
    expect(text).not.toContain("<b>URGENT</b>");
    // The markup this module adds itself is still real markup.
    expect(text).toContain("<blockquote>");
  });

  it("escapes a team contact, which somebody typed into HQ", () => {
    expect(projectMessage(PROJECT, "<script>x</script>")).toContain("&lt;script&gt;");
  });

  it("escapes both halves of a conflict, so neither version can format the other", () => {
    const text = conflictMessages("<b>theirs</b>", "<i>mine</i>").join("\n");
    expect(text).toContain("&lt;b&gt;theirs&lt;/b&gt;");
    expect(text).toContain("&lt;i&gt;mine&lt;/i&gt;");
  });
});

describe("what a week reads like", () => {
  it("uses the inclusive dates and the two status words, never a third state", () => {
    expect(weekLine(WEEK)).toBe("Week of 14 to 20 September. Due Sunday 20 September. Not updated.");
    expect(weekLine({ ...WEEK, completed: true })).toContain("Updated.");
  });

  it("says so plainly when there is no open week", () => {
    expect(weekLine(null)).toBe("There is no open reporting week right now.");
  });

  it("names the audience in full before a save, never after it", () => {
    expect(previewMessages(PROJECT, "text", "shared").join("\n")).toContain(AUDIENCE_NOTES.shared);
    expect(previewMessages(PROJECT, "text", "sensitive").join("\n")).toContain(AUDIENCE_NOTES.sensitive);
  });

  it("says which week the save landed in and what it says now", () => {
    expect(savedMessage("Vault Team", WEEK, true)).toBe("Saved to Vault Team.\nWeek of 14 to 20 September is now Updated.");
  });

  it("names the week that is open now when a draft crossed midnight, and keeps the text", () => {
    const text = periodChangedMessages({ startDate: "2026-09-21", endDate: "2026-09-27" }, "What I wrote").join("\n");
    expect(text).toContain(escapeHtml(ADD_UPDATE_MESSAGES.period_changed));
    expect(text).toContain("21 to 27 September");
    expect(text).toContain("What I wrote");
  });

  it("counts a project's missed weeks on its own screen", () => {
    expect(projectMessage({ ...PROJECT, missedPeriods: 2 }, null)).toContain("2 weeks missed");
  });
});

describe("keyboards", () => {
  it("carries an opaque id and never an instruction", () => {
    const markup = inlineKeyboard([[{ text: "Save", callbackId: "de305d54-75b4-431b-adb2-eb6b9e546014" }]]);
    expect(markup.inline_keyboard[0][0]).toEqual({ text: "Save", callback_data: "de305d54-75b4-431b-adb2-eb6b9e546014" });
    expect(JSON.stringify(markup)).not.toContain("project");
  });

  it("stays inside Telegram's 64 byte callback_data budget", () => {
    const id = "de305d54-75b4-431b-adb2-eb6b9e546014";
    expect(new TextEncoder().encode(id).length).toBeLessThanOrEqual(64);
  });

  it("offers no Open HQ button when there is no public origin to point at", () => {
    expect(openHqButton(null)).toEqual([]);
    expect(openHqButton("https://hq.example.test/hq/captain")).toEqual([{ text: LABELS.openHq, url: "https://hq.example.test/hq/captain" }]);
  });

  it("drops an empty row rather than sending Telegram one", () => {
    expect(inlineKeyboard([[], [{ text: "Back", callbackId: "x" }]]).inline_keyboard).toHaveLength(1);
  });
});

describe("paging and snippets", () => {
  const items = Array.from({ length: 14 }, (_, index) => index);

  it("pages a list and says which way there is to go", () => {
    expect(page(items, 0, 6)).toMatchObject({ index: 0, hasPrevious: false, hasNext: true });
    expect(page(items, 1, 6).items).toEqual([6, 7, 8, 9, 10, 11]);
    expect(page(items, 2, 6)).toMatchObject({ index: 2, hasPrevious: true, hasNext: false });
  });

  it("clamps a page index that is out of range rather than showing nothing", () => {
    expect(page(items, 99, 6).index).toBe(2);
    expect(page(items, -5, 6).index).toBe(0);
    expect(page([], 3, 6)).toMatchObject({ index: 0, items: [], hasPrevious: false, hasNext: false });
  });

  it("flattens a note to one line and marks where it was cut", () => {
    expect(snippet("one\ntwo   three", 40)).toBe("one two three");
    expect(snippet("x".repeat(80), 20)).toHaveLength(20);
    expect(snippet("x".repeat(80), 20).endsWith("...")).toBe(true);
  });
});

describe("message length", () => {
  // A valid 1,000 character note of ampersands: every character escapes to
  // five, so the serialized preview is over 5,000 characters. Slicing it in
  // the transport cut an entity in half, dropped the closing blockquote and
  // took the audience line with it.
  const AMPERSANDS = "&".repeat(1000);

  it("keeps a maximum length note whole, correctly escaped, across as many messages as it takes", () => {
    const parts = previewMessages(PROJECT, "x".repeat(4000), "shared");
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(parts.join("").match(/x/g) ?? []).toHaveLength(4000);
  });

  it("never splits an escaped entity, however much a body expands", () => {
    const parts = previewMessages(PROJECT, AMPERSANDS, "shared");
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
      // No half-written entity at either edge of any part.
      expect(part).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#39;)/);
    }
    expect((parts.join("").match(/&amp;/g) ?? []).length).toBe(1000);
  });

  it("closes every blockquote it opens, in every part", () => {
    for (const part of previewMessages(PROJECT, AMPERSANDS, "sensitive")) {
      expect((part.match(/<blockquote>/g) ?? []).length).toBe((part.match(/<\/blockquote>/g) ?? []).length);
    }
  });

  it("keeps the audience line, which used to be the first thing a truncation took", () => {
    const parts = previewMessages(PROJECT, AMPERSANDS, "shared");
    expect(parts.join("\n")).toContain("Shared.");
    expect(parts.join("\n")).toContain(AUDIENCE_NOTES.shared);
  });

  it("keeps an emoji whole rather than splitting a surrogate pair", () => {
    const chunks = chunkForEscaped("🚀".repeat(50), 20);
    for (const chunk of chunks) expect(chunk).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(chunks.join("")).toBe("🚀".repeat(50));
  });

  it("packs two full bodies for a conflict without losing either", () => {
    // Digits, because the fixed copy around the two bodies has none of them.
    const parts = conflictMessages("1".repeat(4000), "2".repeat(4000));
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    const joined = parts.join("");
    expect((joined.match(/1/g) ?? []).length).toBe(4000);
    expect((joined.match(/2/g) ?? []).length).toBe(4000);
  });

  it("returns one message when everything fits, rather than splitting for its own sake", () => {
    expect(previewMessages(PROJECT, "Short update.", "shared")).toHaveLength(1);
    expect(packMessages([{ fixed: "one" }, { quote: "two" }])).toHaveLength(1);
  });

  it("keeps a very long project name from crowding out the message", () => {
    const parts = previewMessages({ ...PROJECT, projectName: "N".repeat(1000) }, "body", "shared");
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(parts.join("\n")).toContain("Shared.");
  });
});

describe("the Wednesday reminder", () => {
  const PERIOD = { startDate: "2026-09-14", endDate: "2026-09-20" };

  it("names the edition, the week, the deadline and the outstanding teams", () => {
    const text = reminderMessage({ editionName: "Crypto Worlds Fair", period: PERIOD, projectNames: ["Vault Team", "Relay"] });
    expect(text).toContain("Crypto Worlds Fair");
    expect(text).toContain("Week of 14 to 20 September");
    expect(text).toContain("Due Sunday 20 September");
    expect(text).toContain("- Vault Team");
    expect(text).toContain("- Relay");
  });

  it("escapes a team name, because a project name comes from Colosseum", () => {
    const text = reminderMessage({ editionName: "Edition", period: PERIOD, projectNames: ["<b>Ouch</b> & co"] });
    expect(text).toContain("&lt;b&gt;Ouch&lt;/b&gt; &amp; co");
    expect(text).not.toContain("<b>Ouch");
  });

  it("bounds the list rather than growing the message without limit", () => {
    const names = Array.from({ length: REMINDER_PROJECT_LIMIT + 3 }, (_, index) => `Team ${index + 1}`);
    const text = reminderMessage({ editionName: "Edition", period: PERIOD, projectNames: names });
    expect(text).toContain("and 3 more, in HQ.");
    expect(text).not.toContain(`Team ${REMINDER_PROJECT_LIMIT + 1}`);
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
  });

  it("stays inside one Telegram message even with the longest names and the fullest list", () => {
    const names = Array.from({ length: REMINDER_PROJECT_LIMIT }, () => "N".repeat(400));
    const text = reminderMessage({ editionName: "E".repeat(200), period: PERIOD, projectNames: names });
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
  });

  it("says nothing about an audience, a note or how many notes there are", () => {
    const text = reminderMessage({ editionName: "Edition", period: PERIOD, projectNames: ["Vault Team"] }).toLowerCase();
    for (const word of ["sensitive", "note", "shared with", "admins"]) expect(text).not.toContain(word);
  });
});

describe("copy", () => {
  const copy = [
    ...Object.values(BOT_COPY),
    ...Object.values(LABELS),
    ...Object.values(ADD_UPDATE_MESSAGES),
    ...Object.values(EDIT_UPDATE_MESSAGES),
    ...Object.values(AUDIENCE_NOTES),
    weekLine(WEEK),
    savedMessage("Team", WEEK, true),
    reminderMessage({ editionName: "Edition", period: { startDate: "2026-09-14", endDate: "2026-09-20" }, projectNames: ["Team"] }),
  ];

  it("has no em dash and no middot anywhere in it", () => {
    for (const line of copy) expect(line, line).not.toMatch(/[—·]/);
  });

  it("leaves the bot modules free of them as well", () => {
    for (const file of ["lib/hq/telegram-bot.ts", "lib/hq/telegram-bot-view.ts"]) {
      // Comments are prose for the next reader, not interface copy, so only
      // the quoted text is scanned, exactly as the reporting scan does.
      const source = readFileSync(join(process.cwd(), file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/[—·]/);
    }
  });

  it("tells an unconnected person what to do without naming anything in HQ", () => {
    expect(BOT_COPY.notConnected).toContain("connect Telegram");
    expect(BOT_COPY.noCaptainAccess).toContain("Captain access");
    expect(BOT_COPY.noCaptainAccess).toContain("Superteam NL Telegram group");
  });
});
