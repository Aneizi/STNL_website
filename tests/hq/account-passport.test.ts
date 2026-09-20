// The account page's client half (app/hq/(member)/account/account-passport.tsx),
// rendered to static markup: the action rows for each combination of login
// methods, the passport card's facts and switch, the notice slot, and each
// step of the three modals through the presentational AccountModal (static
// markup runs no effects or handlers, so the open state is passed in).
// tests/hq/member-auth-telegram.test.ts drives the whole page against real
// rows; this file pins the design's copy and markup.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The Sign in again control and the refresh after a save need the router to exist, not to navigate.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, replace() {}, push() {} }) }));
vi.mock("@/lib/hq/actions/telegram", () => ({ confirmEmailChange: vi.fn(), confirmLinkTelegram: vi.fn(), confirmUnlinkTelegram: vi.fn(), setBotMessaging: vi.fn() }));
vi.mock("@/lib/hq/member-auth-client", () => ({ memberAuthClient: {} }));
vi.mock("@/components/hq/use-reminder-guide", () => ({ useReminderGuide: () => ({ visible: true, animate: true, dismiss() {}, finishBounce() {} }) }));
// The icon package ships its source; the stand-in renders the props it is given, so the fill="currentColor" convention is still asserted.
vi.mock("symbols-react", () => {
  const icon = (props: Record<string, unknown>) => createElement("svg", props);
  return { IconArrowLeft: icon, IconArrowRight: icon };
});

import { AccountModal, AccountPassport, type AccountModalProps, type AccountPassportProps } from "@/app/hq/(member)/account/account-passport";

const base: AccountPassportProps = {
  name: "Nienke Visser", role: "Builder", email: "nienke@grachtenpay.nl", hasEmail: true, telegram: { username: "nienkev" }, teamName: "Grachtenpay",
  bot: true, botUrl: "https://t.me/fixture_bot", emailAvailable: true, telegramAvailable: true, initialNotice: null, initialError: null,
};
const render = (props: Partial<AccountPassportProps> = {}) => renderToStaticMarkup(createElement(AccountPassport, { ...base, ...props }));

const noop = () => {};
const modalBase: AccountModalProps = {
  kind: "email", hasEmail: false, step: "email", draft: "", confirmed: "", otp: "", pending: false, leaving: false, secondsLeft: 0, error: "", stale: false,
  start: (work) => { void work(); }, onClose: noop, onDraftChange: noop, onOtpChange: noop, onSendCode: noop, onVerify: noop, onDisconnect: noop, onConnect: noop, onStaleError: noop,
};
const modal = (props: Partial<AccountModalProps> = {}) => renderToStaticMarkup(createElement(AccountModal, { ...modalBase, ...props }));

/** The whole <button> element carrying `label`, so its own attributes can be asserted; fails loudly when absent. */
function button(html: string, label: string): string {
  const match = html.match(new RegExp(`<button(?:(?!<\\/button>).)*${label}(?:(?!<\\/button>).)*<\\/button>`, "s"));
  if (!match) throw new Error(`no button labelled ${label}`);
  return match[0];
}
const fact = (html: string, label: string) => html.match(new RegExp(`<dt[^>]*>${label}</dt><dd[^>]*>(.*?)</dd>`))?.[1];

describe("AccountPassport", () => {
  it("carries the Home link, the title, the rows and the passport card, with nothing of the old page", () => {
    const html = render();
    expect(html).toMatch(/<a[^>]*href="\/hq\/dashboard"[^>]*><svg[^>]*fill="currentColor"[^>]*><\/svg>Home<\/a>/);
    expect(html).toMatch(/<h1[^>]*>Your account<\/h1>/);
    expect(html).toMatch(/<p[^>]*>Builder<\/p>/);
    expect(html).toContain(">Nienke Visser</p>");
    expect(fact(html, "Email")).toBe("nienke@grachtenpay.nl");
    expect(fact(html, "Telegram")).toBe("@nienkev");
    expect(fact(html, "Team")).toBe("Grachtenpay");
    expect(html).not.toContain("role=\"status\"");
    expect(html).not.toContain("role=\"alert\"");
    expect(html).not.toContain("role=\"dialog\"");
    for (const gone of ["Superteam NL HQ", "Connected as", "Bot messages", "Enable bot", "not verified", "<em>", "<h2"]) expect(html).not.toContain(gone);
    expect(html).not.toMatch(/[—·]/);
  });

  it("email and Telegram: Change email and Disconnect Telegram as buttons that open a dialog, both with the arrow", () => {
    const html = render();
    expect(button(html, "Change email")).toMatch(/type="button"[^>]*aria-haspopup="dialog"/);
    expect(button(html, "Change email")).toContain('fill="currentColor"');
    expect(button(html, "Disconnect Telegram")).toContain('fill="currentColor"');
    expect(html).not.toContain("Add a recovery email");
    expect(html).not.toContain("Add an email first");
    expect(html).not.toContain("Connect Telegram");
  });

  it("Telegram only: Add a recovery email, and Disconnect Telegram as a blocked row with the reason and no arrow", () => {
    const html = render({ email: null, hasEmail: false });
    expect(html).toContain("Add a recovery email");
    expect(html).not.toContain("Change email");
    const blocked = html.match(/<span aria-disabled="true"[^>]*>Disconnect Telegram<span[^>]*>Add an email first<\/span><\/span>/)?.[0];
    expect(blocked).toBeDefined();
    expect(blocked).not.toContain("<svg");
    expect(html).not.toMatch(/<button[^>]*>Disconnect Telegram/);
    expect(fact(html, "Email")).toBe("None");
  });

  it("email only: Connect Telegram as the filled row, Not connected, and no switch", () => {
    const html = render({ telegram: null, bot: false });
    expect(button(html, "Connect Telegram")).toMatch(/class="[^"]*rowFilled[^"]*"/);
    expect(fact(html, "Telegram")).toBe("Not connected");
    expect(html).not.toContain("Disconnect Telegram");
    expect(html).not.toContain("Bot reminders");
    expect(html).not.toContain('type="checkbox"');
  });

  it("an unverified address is shown but does not count as a login email", () => {
    const html = render({ email: "pending@example.com", hasEmail: false });
    expect(fact(html, "Email")).toBe("pending@example.com");
    expect(html).toContain("Add a recovery email");
    expect(html).toContain("Add an email first");
  });

  it("hides the row of a method that is not available", () => {
    expect(render({ emailAvailable: false })).not.toContain("Change email");
    expect(render({ telegram: null, telegramAvailable: false })).not.toContain("Connect Telegram");
    // Disconnecting needs no provider, so that row stays.
    expect(render({ telegramAvailable: false })).toContain("Disconnect Telegram");
  });

  it("says Connected for a Telegram without a username, and None for no team", () => {
    const html = render({ telegram: { username: null }, teamName: null });
    expect(fact(html, "Telegram")).toBe("Connected");
    expect(fact(html, "Team")).toBe("None");
  });

  it.each(["Captain", "Member", "Builder", "User"] as const)("labels the card %s", (role) => {
    expect(render({ role })).toMatch(new RegExp(`<p[^>]*>${role}</p>`));
  });

  it("draws the switch from the stored decision: a real checkbox in the row, the track orange when on", () => {
    const on = render({ bot: true });
    expect(on).toContain("Bot reminders on Telegram");
    expect(on).toMatch(/<input type="checkbox"[^>]*checked=""[^>]*><span aria-hidden="true"[^>]*switchTrackOn/);
    expect(on).not.toMatch(/<input type="checkbox"[^>]*disabled/);
    const off = render({ bot: false });
    expect(off).toMatch(/<input type="checkbox"[^>]*>/);
    expect(off).not.toMatch(/<input type="checkbox"[^>]*checked/);
    expect(off).not.toContain("switchTrackOn");
    expect(off.match(/<svg[^>]*guideArrow/g)).toHaveLength(3);
    expect(off).not.toMatch(/<path[^>]*d="[^"]*[QC]/);
    expect(on).not.toContain("switchArrows");
    for (const html of [on, off]) expect(html).toContain('href="https://t.me/fixture_bot"');
  });

  it("shows the round trip's notice as a status and its failure as an alert, in the notice slot before the rows", () => {
    const notice = render({ initialNotice: "Telegram connected." });
    expect(notice).toMatch(/<p role="status"[^>]*>Telegram connected\.<\/p>/);
    expect(notice.indexOf('role="status"')).toBeLessThan(notice.indexOf("Change email"));
    const error = render({ initialError: "We could not connect Telegram. Please try again." });
    expect(error).toMatch(/<p role="alert"[^>]*>We could not connect Telegram\. Please try again\.<\/p>/);
    expect(error).not.toContain('role="status"');
  });
});

describe("AccountModal", () => {
  it("is a labelled dialog on an overlay", () => {
    const html = modal();
    expect(html).toMatch(/^<div class="[^"]*overlay[^"]*"><div role="dialog" aria-modal="true" aria-labelledby="ac-modal-title"/);
    expect(html).toMatch(/<h2 id="ac-modal-title"[^>]*>Add email<\/h2>/);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toMatch(/[—·]/);
  });

  it("email step: the address input, Send code and Cancel; Change email and New email once an email exists", () => {
    const add = modal();
    expect(add).toMatch(/<input type="email"[^>]*required=""[^>]*aria-label="Email"[^>]*placeholder="Email"/);
    expect(button(add, "Send code")).toContain('type="submit"');
    expect(button(add, "Send code")).not.toContain("disabled");
    expect(button(add, "Cancel")).toContain('type="button"');
    const change = modal({ hasEmail: true });
    expect(change).toContain(">Change email</h2>");
    expect(change).toContain('placeholder="New email"');
    expect(button(modal({ pending: true }), "Sending…")).toContain("disabled");
  });

  it("code step: the sent-to line, the six-digit input, Verify disabled until six digits, and the resend control with its cooldown", () => {
    const html = modal({ step: "code", confirmed: "nienke@grachtenpay.nl", otp: "12" });
    expect(html).toMatch(/Code sent to <strong>nienke@grachtenpay\.nl<\/strong>/);
    expect(html).toMatch(/<input type="text"[^>]*inputmode="numeric"[^>]*autocomplete="one-time-code"[^>]*maxlength="6"[^>]*aria-label="6-digit code"[^>]*placeholder="6-digit code"/i);
    expect(html).not.toContain("Verification code");
    expect(button(html, "Verify")).toContain("disabled");
    expect(button(modal({ step: "code", otp: "123456" }), "Verify")).not.toContain("disabled");
    expect(button(modal({ step: "code", otp: "123456", pending: true }), "Checking…")).toContain("disabled");
    expect(html).toContain('<button type="button" class="');
    expect(html).toContain(">Resend code</button>");
    expect(modal({ step: "code", secondsLeft: 12 })).toMatch(/<button type="button" class="[^"]*" disabled="">Resend in 12s<\/button>/);
    expect(html).not.toContain("Send code");
    expect(html).not.toContain("Use a different address");
  });

  it("disconnect: the one line, the red Disconnect and Cancel", () => {
    const html = modal({ kind: "disconnect", hasEmail: true });
    expect(html).toContain(">Disconnect Telegram?</h2>");
    expect(html).toContain("You will sign in with your email only. Bot reminders stop.");
    expect(button(html, "Disconnect")).toMatch(/class="[^"]*danger[^"]*"/);
    expect(button(html, "Cancel")).toBeDefined();
    expect(html).not.toContain("<form");
  });

  it("connect: the one line, Open Telegram, and Opening Telegram… while pending or leaving", () => {
    const html = modal({ kind: "connect", hasEmail: true });
    expect(html).toContain(">Connect Telegram</h2>");
    expect(html).toContain("Opens Telegram. Approve there and you are back here.");
    expect(button(html, "Open Telegram")).not.toContain("disabled");
    expect(button(modal({ kind: "connect", pending: true }), "Opening Telegram…")).toContain("disabled");
    expect(button(modal({ kind: "connect", leaving: true }), "Opening Telegram…")).toContain("disabled");
  });

  it("shows a failure as an alert after the body, and the way out of a stale session after that", () => {
    const html = modal({ error: "Enter a valid email.", stale: true });
    expect(html).toMatch(/<p role="alert"[^>]*>Enter a valid email\.<\/p>/);
    expect(html.indexOf('role="alert"')).toBeGreaterThan(html.indexOf("Send code"));
    expect(html).toMatch(/<button type="button"[^>]*>Sign in again<\/button>/);
    expect(html.indexOf("Sign in again")).toBeGreaterThan(html.indexOf('role="alert"'));
    expect(modal({ error: "Enter a valid email." })).not.toContain("Sign in again");
  });
});

describe("the account page source", () => {
  it("keeps the copy free of em dashes and middots, and imports nothing operator-side", () => {
    for (const file of ["app/hq/(member)/account/account-passport.tsx", "app/hq/(member)/account/page.tsx", "app/hq/(member)/account/email-copy.ts"]) {
      const source = readFileSync(join(process.cwd(), file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/[—·]/);
      expect(source, file).not.toMatch(/lib\/hq\/(queries|db|auth|session|hackathon|authz)"|components\/hq\/(chrome|toast|ui|ui-client)"/);
    }
  });
});
