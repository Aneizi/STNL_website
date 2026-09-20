// The two operator auth cards (components/hq/login-form.tsx and
// change-password-form.tsx) rendered to static markup: the design's copy,
// the labelled controls, the type scale, and the error line in each of its
// states. useActionState is mocked to a fixed [result, action, pending]
// tuple, the way tests/hq/invite-accept-form.test.ts does it, since static
// markup never runs a transition; the pre-checks the submit handlers run are
// pure over FormData and are called directly. The actions themselves are
// exercised against PGlite in tests/hq/operator-auth-actions.test.ts.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginResult } from "@/lib/hq/actions/auth";
import type { ActionResult } from "@/lib/hq/types";

const mocks = vi.hoisted(() => ({ useActionState: vi.fn(), login: vi.fn(), changePassword: vi.fn() }));
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), useActionState: mocks.useActionState }));
vi.mock("@/lib/hq/actions/auth", () => ({ login: mocks.login, changePassword: mocks.changePassword }));

import { ChangePasswordForm, changePasswordPrecheck } from "@/components/hq/change-password-form";
import { LoginForm, loginPrecheck } from "@/components/hq/login-form";

function withState(result: LoginResult | ActionResult | null, pending = false) {
  mocks.useActionState.mockReturnValue([result, vi.fn(), pending]);
}
function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}
const alertText = (html: string) => html.match(/<div role="alert"[^>]*>(.*?)<\/div>/)?.[1] ?? "";

const renderLogin = () => renderToStaticMarkup(createElement(LoginForm));
const renderChange = () => renderToStaticMarkup(createElement(ChangePasswordForm, { displayName: "Nienke" }));

beforeEach(() => { vi.clearAllMocks(); });

describe("LoginForm", () => {
  it("renders the design's card: title, subtitle, two labelled fields and the submit, wired to the real login action", () => {
    withState(null);
    const html = renderLogin();
    expect(html).toContain("Admin login");
    expect(html).toContain("For admins only.");
    expect(html).toMatch(/<label for="admin-username"[^>]*>Username<\/label>/);
    expect(html).toMatch(/<input id="admin-username" autoCapitalize="none" autoComplete="username"[^>]*name="username"/);
    expect(html).toMatch(/<label for="admin-password"[^>]*>Password<\/label>/);
    expect(html).toMatch(/<input id="admin-password" type="password" autoComplete="current-password"[^>]*name="password"/);
    expect(html).toMatch(/<button type="submit"[^>]*>Sign in<\/button>/);
    expect(html).not.toContain("disabled");
    expect(html).not.toContain('role="alert"');
    // The pre-check speaks for the empty fields; a native tooltip would replace its copy.
    expect(html).not.toContain("required");
    expect(html).not.toMatch(/[—·]/);
    expect(mocks.useActionState).toHaveBeenCalledWith(mocks.login, null);
  });

  it("sits on the 20px scale with 50px controls and plain labels", () => {
    withState(null);
    const html = renderLogin();
    expect(html.match(/font-size:20px/g)).toHaveLength(6);
    expect(html.match(/min-height:50px/g)).toHaveLength(3);
    expect(html).toContain("font-size:32px");
    expect(html).not.toContain("font-size:17px");
    expect(html).not.toContain("text-transform:uppercase");
    expect(html).toContain('class="hq-fade-in-page"');
  });

  it("disables the button and changes its label while pending", () => {
    withState(null, true);
    const html = renderLogin();
    expect(html).toContain("Signing in…");
    expect(html).toMatch(/<button type="submit" disabled=""/);
    expect(html).toContain("opacity:0.5");
  });

  it("shows the action's refusal as an alert and keeps the username", () => {
    withState({ ok: false, error: "Invalid username or password.", username: "fictional.operator" });
    const html = renderLogin();
    expect(alertText(html)).toBe("Invalid username or password.");
    expect(html).toContain('value="fictional.operator"');
    expect(html).toMatch(/<div role="alert" style="font-size:20px;color:var\(--red\);margin-top:10px"/);
  });

  it("clears the previous refusal while a new attempt is in flight", () => {
    withState({ ok: false, error: "Invalid username or password.", username: "fictional.operator" }, true);
    expect(renderLogin()).not.toContain('role="alert"');
  });

  it("asks for both fields before the action is called, with the design's copy", () => {
    expect(loginPrecheck(form({ username: "", password: "" }))).toBe("Enter your username and password.");
    expect(loginPrecheck(form({ username: "fictional.operator", password: "" }))).toBe("Enter your username and password.");
    expect(loginPrecheck(form({ username: "", password: "fictional-operator-passphrase" }))).toBe("Enter your username and password.");
    expect(loginPrecheck(form({ username: "fictional.operator", password: "fictional-operator-passphrase" }))).toBeNull();
  });
});

describe("ChangePasswordForm", () => {
  it("renders the design's card: the serif welcome, the note, two labelled fields and the submit, wired to the real action", () => {
    withState(null);
    const html = renderChange();
    expect(html).toContain('Welcome, <em style="color:var(--accent)">Nienke</em>');
    expect(html).toContain("Your temporary password needs replacing. Choose a new one to continue.");
    expect(html).toMatch(/<label for="new-password"[^>]*>New password<\/label>/);
    expect(html).toMatch(/<input id="new-password" type="password" placeholder="At least 12 characters" autoComplete="new-password"[^>]*name="password"/);
    expect(html).toMatch(/<label for="confirm-password"[^>]*>Confirm password<\/label>/);
    expect(html).toMatch(/<input id="confirm-password" type="password" autoComplete="new-password"[^>]*name="confirm"/);
    expect(html).toMatch(/<button type="submit"[^>]*>Set new password<\/button>/);
    expect(html).not.toContain("disabled");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("required");
    expect(html).not.toMatch(/[—·]/);
    expect(mocks.useActionState).toHaveBeenCalledWith(mocks.changePassword, null);
  });

  it("sits on the design's scale, with uppercase kicker labels and 44px controls", () => {
    withState(null);
    const html = renderChange();
    expect(html).toContain("font-family:var(--serif);font-size:36px");
    expect(html).toContain("font-size:16px");
    expect(html.match(/font-size:14px/g)).toHaveLength(2);
    expect(html.match(/text-transform:uppercase/g)).toHaveLength(2);
    expect(html.match(/font-size:18px/g)).toHaveLength(3);
    expect(html.match(/min-height:44px/g)).toHaveLength(3);
    expect(html).not.toMatch(/font-size:1[235]px/);
    expect(html).toContain('class="hq-fade-in-page"');
  });

  it("disables the button and changes its label while pending", () => {
    withState(null, true);
    const html = renderChange();
    expect(html).toContain("Saving…");
    expect(html).toMatch(/<button type="submit" disabled=""/);
    expect(html).toContain("opacity:0.5");
  });

  it("shows the action's refusal as a 14px alert", () => {
    withState({ ok: false, error: "The passwords do not match." });
    const html = renderChange();
    expect(alertText(html)).toBe("The passwords do not match.");
    expect(html).toMatch(/<div role="alert" style="font-size:14px;color:var\(--red\);margin-top:10px"/);
  });

  it("clears the previous refusal while a new attempt is in flight", () => {
    withState({ ok: false, error: "Use at least 12 characters." }, true);
    expect(renderChange()).not.toContain('role="alert"');
  });

  it("checks the length first and the confirmation second, in the words the action also uses", () => {
    expect(changePasswordPrecheck(form({ password: "short", confirm: "short" }))).toBe("Use at least 12 characters.");
    expect(changePasswordPrecheck(form({ password: "eleven-chars", confirm: "eleven-chars" }))).toBeNull();
    expect(changePasswordPrecheck(form({ password: "elevenchars", confirm: "elevenchars" }))).toBe("Use at least 12 characters.");
    expect(changePasswordPrecheck(form({ password: "second-fictional-passphrase", confirm: "a-different-passphrase" }))).toBe("The passwords do not match.");
    expect(changePasswordPrecheck(form({ password: "second-fictional-passphrase" }))).toBe("The passwords do not match.");
    expect(changePasswordPrecheck(form({}))).toBe("Use at least 12 characters.");
    expect(changePasswordPrecheck(form({ password: "second-fictional-passphrase", confirm: "second-fictional-passphrase" }))).toBeNull();
  });
});
