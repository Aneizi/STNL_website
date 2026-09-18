// The member header: the brand link and the account corner's avatar menu,
// rendered to static markup (no DOM here, so the open state is passed in to
// the presentational piece and the stateful one is checked closed). The
// initials rule is tabled on its own.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The Sign out item routes after signing out; static markup needs the hook to exist, not to navigate.
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }) }));

import { AccountMenu, BuilderAccountMenu, MemberAccountProvider, SIGN_OUT_FAILED, initials, type MemberAccountState } from "@/components/hq/builder-account-menu";
import { BuilderShell } from "@/components/hq/builder-shell";

/** createElement with the children as arguments (the lint rule) for a component whose props type lists them (the type check). */
function withChildren<P extends { children: React.ReactNode }>(type: React.ComponentType<P>, props: Omit<P, "children">, ...children: React.ReactNode[]) {
  return createElement(type as unknown as React.ComponentType<Omit<P, "children">>, props, ...children);
}
const provided = (node: React.ReactElement, value: MemberAccountState) => renderToStaticMarkup(withChildren(MemberAccountProvider, { value }, node));
const noop = () => {};
const menu = (props: Partial<Parameters<typeof AccountMenu>[0]> = {}) =>
  renderToStaticMarkup(createElement(AccountMenu, { name: "Nienke Visser", open: false, pending: false, error: "", onToggle: noop, onClose: noop, onSignOut: noop, ...props }));

describe("initials", () => {
  it.each([
    ["Nienke Visser", "NV"],
    ["Femke de Jong", "FD"],
    ["Nienke", "N"],
    ["a b c", "AB"],
    ["  Nienke   Visser  ", "NV"],
    ["", ""],
    ["   ", ""],
  ])("%j gives %j", (name, expected) => {
    expect(initials(name)).toBe(expected);
  });
});

describe("the account menu", () => {
  it("closed: a 44px avatar with the initials, expanded false, and no menu, name or items", () => {
    const html = menu();
    expect(html).toMatch(/<button[^>]*type="button"[^>]*aria-label="Account menu"[^>]*aria-expanded="false"[^>]*>NV<\/button>/);
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain("Nienke Visser");
    expect(html).not.toContain("Sign out");
    expect(html).not.toContain(">Account<");
  });

  it("open: the name row, Account as a link to the account page and Sign out as a button, nothing operator-side", () => {
    const html = menu({ open: true });
    expect(html).toMatch(/aria-label="Account menu"[^>]*aria-expanded="true"/);
    expect(html).toContain('role="menu"');
    expect(html).toContain(">Nienke Visser</div>");
    expect(html).toMatch(/<a[^>]*href="\/hq\/account"[^>]*>Account<\/a>/);
    expect(html).toMatch(/<a[^>]*role="menuitem"[^>]*>Account<\/a>/);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*role="menuitem"[^>]*>Sign out<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Sign out<\/button>/);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toMatch(/[—·]/);
    expect(html.toLowerCase()).not.toMatch(/operator|admin/);
  });

  it("keeps the items in one menu, without separators or a second name line", () => {
    const html = menu({ open: true });
    expect(html.match(/role="menuitem"/g)).toHaveLength(2);
    expect(html.match(/Nienke Visser/g)).toHaveLength(1);
    expect(html).not.toContain("<hr");
  });

  it("disables Sign out while the sign-out is pending", () => {
    expect(menu({ open: true, pending: true })).toMatch(/<button[^>]*disabled[^>]*>Sign out<\/button>/);
  });

  it("shows a failed sign-out inside the open menu as an alert", () => {
    const html = menu({ open: true, error: SIGN_OUT_FAILED });
    expect(html).toMatch(/<p[^>]*role="alert"[^>]*>Could not sign out\. Please try again\.<\/p>/);
    expect(html.indexOf('role="alert"')).toBeGreaterThan(html.indexOf('role="menu"'));
  });

  it("renders the avatar with no initials and no name row for an account that has no name yet", () => {
    expect(menu({ name: "" })).toMatch(/aria-label="Account menu"[^>]*><\/button>/);
    const open = menu({ name: "  ", open: true });
    expect(open).toMatch(/<div role="menu"[^>]*><a/);
    expect(open).toMatch(/<a[^>]*>Account<\/a>/);
  });
});

describe("the stateful menu", () => {
  it("renders the closed avatar for the provided member", () => {
    const html = provided(createElement(BuilderAccountMenu), { name: "Fictional Builder" });
    expect(html).toMatch(/aria-label="Account menu"[^>]*aria-expanded="false"[^>]*>FB<\/button>/);
    expect(html).not.toContain("Fictional Builder");
  });

  it("renders nothing without a signed-in member, so the pre-auth screens and a signed-out invite page carry no avatar", () => {
    expect(provided(createElement(BuilderAccountMenu), null)).toBe("");
    expect(renderToStaticMarkup(createElement(BuilderAccountMenu))).toBe("");
  });
});

describe("the shell", () => {
  const content = createElement("p", null, "content");
  const member: MemberAccountState = { name: "Fictional Builder" };

  it("carries the brand link to Home, the avatar and the content, and no navigation", () => {
    const html = provided(withChildren(BuilderShell, {}, content), member);
    const brand = html.match(/<a[^>]*aria-label="Superteam NL home"[^>]*>/)?.[0] ?? "";
    expect(brand).toContain('href="/hq/dashboard"');
    expect(html).toMatch(/<img[^>]*alt=""[^>]*>/);
    expect(html).toMatch(/<img[^>]*sizes="28px"[^>]*>/);
    expect(html).toContain("st-orange.png");
    expect(html).toContain("Superteam NL</a>");
    expect(html).not.toContain("superteam NL");
    expect(html).toMatch(/aria-label="Account menu"[^>]*>FB<\/button>/);
    expect(html).toContain("<p>content</p>");
    expect(html).not.toContain("<nav");
    expect(html).not.toContain("HQ navigation");
    for (const label of ["Register team", "My teams", "Connect Telegram", "Captain"]) expect(html).not.toContain(label);
    expect(html).not.toMatch(/[—·]/);
    expect(html.toLowerCase()).not.toMatch(/operator|hq-chrome|activity/);
  });

  it("renders a Back link only for a step in a flow", () => {
    expect(provided(withChildren(BuilderShell, { back: "/hq/welcome" }, content), member)).toMatch(/<a[^>]*href="\/hq\/welcome"[^>]*>Back<\/a>/);
    expect(provided(withChildren(BuilderShell, {}, content), member)).not.toContain(">Back<");
  });

  it("keeps the brand and drops the avatar for a signed-out visitor, the invite page's case", () => {
    const html = provided(withChildren(BuilderShell, {}, content), null);
    expect(html).toContain('aria-label="Superteam NL home"');
    expect(html).not.toContain("Account menu");
    expect(html).not.toContain("Sign out");
  });

  it("bare: the header, then the children in a main with none of the column's classes and no Back link", () => {
    const html = provided(withChildren(BuilderShell, { bare: true, back: "/hq/welcome", wide: true }, content), member);
    expect(html).toMatch(/<main class="[^"]*bare[^"]*"><p>content<\/p><\/main>/);
    expect(html).not.toMatch(/<main class="[^"]*(main|wide|workspace)[^"]*"/);
    expect(html).not.toContain(">Back<");
    expect(html).toContain('aria-label="Account menu"');
  });
});
