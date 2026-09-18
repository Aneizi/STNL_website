// The public sign-in form, rendered to static markup: the page's own header,
// the two methods, the honest unavailable state for each combination, the
// verify step, the Telegram error copy, and the absence of the removed
// providers.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ presetState: [] as unknown[] }));
// The icon package ships its source, so importing it makes vitest transform
// thousands of icons. The stand-in renders the props it is given, so the
// fill="currentColor" convention is still asserted on what the form passes.
vi.mock("symbols-react", () => {
  const icon = (props: Record<string, unknown>) => createElement("svg", props);
  return { IconArrowLeft: icon, IconArrowRight: icon, IconPaperplaneFill: icon };
});
// The shared sign-in-again control routes after signing out; static markup needs the hook to exist, not to navigate.
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }) }));
// Static markup renders the initial state only. The form's own state slots
// are the first useState calls of a render (a parent renders before its
// children), so a preset list stands in for as many of them as a test
// needs to reach the verify step; every later call, the form's remaining
// slots and the image's, keeps React's own hook.
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => (mocks.presetState.length ? [mocks.presetState.shift(), () => {}] : react.useState(initial)) };
});

import { AccountForm } from "@/app/hq/(member)/account-form";
import { CODE_SENT_COPY, OtpCodeField, ResendCodeButton } from "@/app/hq/(member)/otp-code-field";
import { SignInAgain } from "@/app/hq/(member)/stale-session";
import type { MemberAuthAvailability } from "@/lib/hq/member-auth-config";
import { INVALID_EMAIL_COPY, LAST_LOGIN_METHOD_COPY, lastParam, telegramErrorMessage, telegramFailure } from "@/app/hq/(member)/telegram-copy";

type Props = Partial<Parameters<typeof AccountForm>[0]>;

const both: MemberAuthAvailability = { configured: true, email: true, telegram: true };
const render = (props: Props = {}, state: unknown[] = []) => {
  mocks.presetState = state;
  return renderToStaticMarkup(createElement(AccountForm, { next: "/hq/welcome", availability: both, ...props }));
};
/** The form on the verify step, in slot order: step, the address a code went to, the digits typed so far, busy. */
const verifyStep = (otp = "", busy = false) => render({}, ["verify", "nienke@example.com", otp, busy]);
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
    expect(html).toContain("<h1>Enter HQ</h1>");
    expect(html.indexOf("Continue with Telegram")).toBeGreaterThan(-1);
    expect(html.indexOf("Continue with Telegram")).toBeLessThan(html.indexOf("Continue with email"));
    expect(html).toContain("or use email");
    expect(html).toContain('aria-label="Email"');
    expect(html).toContain('placeholder="example@gmail.com"');
    expect(html).toContain("We&#x27;ll email you a verification code. No password needed.");
    expect(telegramButton(html)).not.toContain("disabled");
    expect(emailButton(html)).not.toContain("disabled");
    expect(html).not.toContain("not available");
    expect(html.toLowerCase()).not.toMatch(/google|github/);
    // No sign-up variant is left: no name field, no switch to another form.
    expect(html).not.toContain('name="name"');
    expect(html).not.toContain("Already have an account");
    // No em dashes or middots in copy.
    expect(html).not.toMatch(/[—·]/);
    expect(html).toContain('fill="currentColor"');
  });

  it("keeps its own header: the brand is plain text, not a link, and Back leads out of HQ", () => {
    const html = render();
    expect(html).toContain("Superteam NL");
    expect(html).not.toContain("superteam NL");
    expect(html).toMatch(/<span[^>]*><img[^>]*><span>Superteam NL<\/span><\/span>/);
    expect(html).not.toMatch(/<a[^>]*href="\/"[^>]*>/);
    expect(html).toMatch(/<a[^>]*href="\/colosseum\/start"[^>]*><svg[^>]*><\/svg>Back<\/a>/);
    expect(html).not.toContain("Account menu");
  });

  it("says which method is unavailable and points at the other", () => {
    const noTelegram = render({ availability: { ...both, telegram: false } });
    expect(noTelegram).toContain("Telegram sign-in is not available yet. Use email below.");
    expect(telegramButton(noTelegram)).toContain("disabled");
    expect(emailButton(noTelegram)).not.toContain("disabled");
    expect(noTelegram).not.toContain("Email sign-in is not available");

    const noEmail = render({ availability: { ...both, email: false } });
    expect(noEmail).toContain("Email sign-in is not available yet. Use Telegram above.");
    expect(emailButton(noEmail)).toContain("disabled");
    expect(telegramButton(noEmail)).not.toContain("disabled");
    expect(noEmail).not.toContain("Telegram sign-in is not available");
  });

  it("collapses to one honest line when neither method is configured", () => {
    const html = render({ availability: { configured: true, email: false, telegram: false } });
    expect(html).toContain("Sign-in is not available yet. Please check back shortly.");
    expect(html.match(/not available/g)).toHaveLength(1);
    expect(telegramButton(html)).toContain("disabled");
    expect(emailButton(html)).toContain("disabled");
  });

  it("asks for the code on the verify step and never locks the way back to the address", () => {
    const html = verifyStep();
    expect(html).toContain("<h1>Check your email</h1>");
    expect(html).toContain("Enter the 6-digit code sent to <strong>nienke@example.com</strong>.");
    expect(html).not.toContain("Continue with Telegram");
    expect(html).not.toContain("or use email");
    expect(html).toContain("Verification code");
    expect(html).toContain('aria-describedby="code-status account-error"');
    expect(html).toContain('<p id="code-status" role="status"');
    // Verify needs all six digits; the two text actions sit under it.
    expect(button(html, "Verify and continue")).toContain("disabled");
    expect(button(verifyStep("123456"), "Verify and continue")).not.toContain("disabled");
    expect(button(html, "Resend code")).not.toContain("disabled");
    expect(button(html, "Change email")).not.toContain("disabled");
    // While a code is being checked, only Change email stays live.
    const busy = verifyStep("123456", true);
    expect(button(busy, "Checking code…")).toContain("disabled");
    expect(button(busy, "Resend code")).toContain("disabled");
    expect(button(busy, "Change email")).not.toContain("disabled");
    expect(busy).not.toMatch(/[—·]/);
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

  it("uses one line for an address that cannot take a code, before and after the request", () => {
    expect(INVALID_EMAIL_COPY).toBe("Enter a valid email address.");
    expect(telegramErrorMessage("INVALID_EMAIL")).toBe(INVALID_EMAIL_COPY);
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
    const html = renderToStaticMarkup(createElement(SignInAgain, { next: "/hq/account", start, disabled: false, onError: () => {} }));
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
    expect(CODE_SENT_COPY).toBe("Code sent. It expires in 15 minutes.");
  });
});
