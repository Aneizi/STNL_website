// The public sign-in form, rendered to static markup: the two methods, the
// honest unavailable state for each combination and mode, the Telegram error
// copy, and the absence of the removed providers.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The icon package ships its source, so importing it makes vitest transform
// thousands of icons. The stand-in renders the props it is given, so the
// fill="currentColor" convention is still asserted on what the form passes.
vi.mock("symbols-react", () => {
  const icon = (props: Record<string, unknown>) => createElement("svg", props);
  return { IconArrowLeft: icon, IconArrowRight: icon, IconPaperplaneFill: icon };
});
// The shared sign-in-again control routes after signing out; static markup needs the hook to exist, not to navigate.
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }) }));

import { AccountForm } from "@/app/hq/(member)/account-form";
import { CODE_SENT_COPY, OtpCodeField, ResendCodeButton } from "@/app/hq/(member)/otp-code-field";
import { SignInAgain } from "@/app/hq/(member)/stale-session";
import type { MemberAuthAvailability } from "@/lib/hq/member-auth-config";
import { LAST_LOGIN_METHOD_COPY, lastParam, telegramErrorMessage, telegramFailure } from "@/app/hq/(member)/telegram-copy";

type Props = Partial<Parameters<typeof AccountForm>[0]>;

const both: MemberAuthAvailability = { configured: true, email: true, telegram: true };
const render = (props: Props = {}) => renderToStaticMarkup(createElement(AccountForm, { mode: "signin", next: "/hq/welcome", availability: both, ...props }));
/** The whole <button> element carrying `label`, so its own attributes can be asserted; fails loudly when absent. */
function button(html: string, label: string): string {
  const match = html.match(new RegExp(`<button(?:(?!<\\/button>).)*${label}(?:(?!<\\/button>).)*<\\/button>`, "s"));
  if (!match) throw new Error(`no button labelled ${label}`);
  return match[0];
}
const telegramButton = (html: string) => button(html, "Continue with Telegram");
const emailButton = (html: string) => button(html, "Continue with email");
const alertText = (html: string) => html.match(/<p id="account-error" role="alert"[^>]*>(.*?)<\/p>/)?.[1] ?? "";

describe("AccountForm", () => {
  it("offers Telegram first and email second, with nothing left of the removed providers", () => {
    const html = render();
    expect(html.indexOf("Continue with Telegram")).toBeGreaterThan(-1);
    expect(html.indexOf("Continue with Telegram")).toBeLessThan(html.indexOf("Continue with email"));
    expect(html).toContain("or use email");
    expect(telegramButton(html)).not.toContain("disabled");
    expect(emailButton(html)).not.toContain("disabled");
    expect(html).not.toContain("not available");
    expect(html.toLowerCase()).not.toMatch(/google|github/);
    // No em dashes or middots in copy.
    expect(html).not.toMatch(/[—·]/);
    expect(html).toContain('fill="currentColor"');
  });

  it("shows the name field only when creating an account", () => {
    expect(render({ mode: "signup" })).toContain('name="name"');
    expect(render({ mode: "signin" })).not.toContain('name="name"');
  });

  it("says which method is unavailable and points at the other, per mode", () => {
    const noTelegram = render({ availability: { ...both, telegram: false } });
    expect(noTelegram).toContain("Telegram sign-in is not available yet. Use email below.");
    expect(telegramButton(noTelegram)).toContain("disabled");
    expect(emailButton(noTelegram)).not.toContain("disabled");
    expect(noTelegram).not.toContain("Email sign-in is not available");

    const noEmail = render({ mode: "signup", availability: { ...both, email: false } });
    expect(noEmail).toContain("Email sign-up is not available yet. Use Telegram above.");
    expect(emailButton(noEmail)).toContain("disabled");
    expect(telegramButton(noEmail)).not.toContain("disabled");
    expect(noEmail).not.toContain("Telegram sign-up is not available");
  });

  it("collapses to one honest line when neither method is configured", () => {
    for (const [mode, line] of [["signin", "Sign-in is not available yet. Please check back shortly."], ["signup", "Sign-up is not available yet. Please check back shortly."]] as const) {
      const html = render({ mode, availability: { configured: true, email: false, telegram: false } });
      expect(html).toContain(line);
      expect(html.match(/not available/g)).toHaveLength(1);
      expect(telegramButton(html)).toContain("disabled");
      expect(emailButton(html)).toContain("disabled");
    }
  });

  it("renders the Telegram outcome codes as copy and ignores codes that are not Telegram outcomes", () => {
    expect(alertText(render({ error: "account_already_linked_to_different_user" }))).toBe("This Telegram account is already connected to another HQ account. Sign in to that account instead.");
    expect(alertText(render({ error: "telegram_identity_conflict" }))).toBe("This Telegram account is already connected to another HQ account. Sign in to that account instead.");
    expect(alertText(render({ error: "SESSION_NOT_FRESH" }))).toBe("Please sign in again to continue.");
    expect(alertText(render({ error: "state_mismatch" }))).toContain("expired or was already used");
    expect(alertText(render({ error: "identity_missing" }))).toBe("Your Telegram sign-in did not complete. Please sign in again.");
    expect(alertText(render({ error: "telegram" }))).toBe("We could not sign you in with Telegram. Please try again.");
    // The callback appends its code after our `telegram` marker; the specific one wins wherever it sits.
    expect(alertText(render({ error: ["telegram", "state_mismatch"] }))).toContain("expired or was already used");
    expect(alertText(render({ error: ["telegram", "account_already_linked_to_different_user"] }))).toContain("already connected to another HQ account");
    // Cancelling at Telegram, or any other unmapped callback code, is still shown as a Telegram failure.
    for (const code of ["access_denied", "unable_to_get_user_info", "unable_to_link_account", "oauth_provider_not_found", "no_callback_url", "email_not_verified", "issuer_missing", "invalid_callback_request"]) {
      expect(alertText(render({ error: ["telegram", code] })), code).toBe("We could not sign you in with Telegram. Please try again.");
    }
    // An unrelated `?error=` is not a Telegram outcome.
    expect(alertText(render({ error: "oauth" }))).toBe("");
    expect(alertText(render({ error: "access_denied" }))).toBe("");
    expect(alertText(render({ error: [] }))).toBe("");
    expect(alertText(render())).toBe("");
  });
});

describe("telegram copy helpers", () => {
  it("reads the last error value, which is the one the callback appended", () => {
    expect(lastParam(["telegram", "state_mismatch"])).toBe("state_mismatch");
    expect(lastParam("telegram")).toBe("telegram");
    expect(lastParam(undefined)).toBeUndefined();
  });

  it("phrases a generic failure for the action it interrupted", () => {
    expect(telegramErrorMessage("telegram", "connect")).toBe("We could not connect Telegram. Please try again.");
    expect(telegramErrorMessage(["telegram", "access_denied"], "connect")).toBe(telegramFailure("connect"));
    expect(telegramErrorMessage(["telegram", "access_denied"], "signin")).toBe(telegramFailure("signin"));
    expect(telegramErrorMessage("LAST_LOGIN_METHOD", "connect")).toBe(LAST_LOGIN_METHOD_COPY);
    expect(telegramErrorMessage("CONFIRMATION_REQUIRED")).toBe("Please confirm this change again.");
    expect(telegramErrorMessage(undefined)).toBeNull();
    expect(telegramErrorMessage("something_else")).toBeNull();
    expect(telegramErrorMessage(["something_else", "another"])).toBeNull();
  });

  it("looks codes up as own keys only, so Object.prototype names in the URL are just another unknown code", () => {
    for (const value of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(telegramErrorMessage(value), value).toBeNull();
      expect(telegramErrorMessage(["telegram", value]), value).toBe(telegramFailure("signin"));
    }
    expect(alertText(render({ error: ["telegram", "__proto__"] }))).toBe(telegramFailure("signin"));
  });
});

describe("the pieces the code forms share", () => {
  const start = (work: () => void) => work();

  it("renders the sign-in-again control a stale session needs, disabled with its form", () => {
    const html = renderToStaticMarkup(createElement(SignInAgain, { next: "/hq/account/add-email", start, disabled: false, onError: () => {} }));
    expect(html).toMatch(/<button type="button"[^>]*>Sign in again<\/button>/);
    expect(html).not.toContain("disabled");
    expect(renderToStaticMarkup(createElement(SignInAgain, { next: "/hq/account", start, disabled: true, onError: () => {} }))).toContain("disabled");
  });

  it("renders the code field with one-time-code semantics and a resend button that counts down", () => {
    const field = renderToStaticMarkup(createElement(OtpCodeField, { value: "12", onChange: () => {}, disabled: false, describedBy: "code-status account-error", inputClassName: "code" }));
    expect(field).toContain("Verification code");
    // renderToStaticMarkup keeps React's attribute spellings (inputMode, autoComplete, minLength, maxLength).
    for (const attribute of ['name="code"', 'inputMode="numeric"', 'autoComplete="one-time-code"', 'pattern="[0-9]{6}"', 'minLength="6"', 'maxLength="6"', 'aria-describedby="code-status account-error"', 'class="code"', 'value="12"', "required"]) {
      expect(field, attribute).toContain(attribute);
    }
    expect(renderToStaticMarkup(createElement(OtpCodeField, { value: "", onChange: () => {}, disabled: true }))).toContain("disabled");
    expect(renderToStaticMarkup(createElement(ResendCodeButton, { secondsLeft: 12, disabled: false, onClick: () => {} }))).toMatch(/<button type="button" disabled="">Resend in 12s<\/button>/);
    expect(renderToStaticMarkup(createElement(ResendCodeButton, { secondsLeft: 0, disabled: false, onClick: () => {} }))).toBe('<button type="button">Resend code</button>');
    expect(renderToStaticMarkup(createElement(ResendCodeButton, { secondsLeft: 0, disabled: true, onClick: () => {}, className: "textButton" }))).toMatch(/<button type="button" class="textButton" disabled="">Resend code<\/button>/);
    expect(CODE_SENT_COPY).toBe("Code sent. It expires in 5 minutes.");
  });
});
