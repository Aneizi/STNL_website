// The member navigation, derived from what the account holds and rendered
// with the current path. The derivation is pure so every capability set is a
// table here; the markup checks are the client piece with usePathname stubbed.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pathname: "/hq/dashboard" }));
vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  // The sign-out control routes after signing out; static markup needs the hook to exist, not to navigate.
  useRouter: () => ({ replace() {}, refresh() {} }),
}));

import { BuilderAccount, BuilderNav, MemberNavProvider, type MemberNavState } from "@/components/hq/builder-nav";
import { BuilderShell } from "@/components/hq/builder-shell";
import type { Capability } from "@/lib/hq/capabilities";
import { getMemberNav, isNavItemCurrent, type NavItem } from "@/lib/hq/member-nav";
import { isMemberPath } from "@/lib/hq/member-routes";

const caps = (...values: Capability[]) => new Set<Capability>(values);
/** createElement with the children as arguments (the lint rule) for a component whose props type lists them (the type check). */
function withChildren<P extends { children: React.ReactNode }>(type: React.ComponentType<P>, props: Omit<P, "children">, ...children: React.ReactNode[]) {
  return createElement(type as unknown as React.ComponentType<Omit<P, "children">>, props, ...children);
}
const labels = (items: NavItem[]) => items.map((item) => item.label);
const href = (items: NavItem[], label: string) => items.find((item) => item.label === label)?.href;

describe("getMemberNav", () => {
  it("email-only account with no teams: Home, Register team, Connect Telegram, Account", () => {
    const items = getMemberNav({ capabilities: caps(), hasTelegram: false, hasTeams: false });
    expect(labels(items)).toEqual(["Home", "Register team", "Connect Telegram", "Account"]);
    expect(href(items, "Home")).toBe("/hq/dashboard");
    expect(href(items, "Register team")).toBe("/hq/initialize");
    expect(href(items, "Connect Telegram")).toBe("/hq/account");
    expect(href(items, "Account")).toBe("/hq/account");
  });

  it("Telegram-only account with teams: Home, My teams, Account", () => {
    const items = getMemberNav({ capabilities: caps(), hasTelegram: true, hasTeams: true });
    expect(labels(items)).toEqual(["Home", "My teams", "Account"]);
    expect(href(items, "My teams")).toBe("/hq/dashboard");
  });

  it("captain who is also a team member sees both modules together", () => {
    const items = getMemberNav({ capabilities: caps("captain"), hasTelegram: true, hasTeams: true });
    expect(labels(items)).toEqual(["Home", "My teams", "Captain", "Account"]);
    expect(href(items, "Captain")).toBe("/hq/captain");
  });

  it("captain without Telegram or a team sees Register team, Captain and Connect Telegram", () => {
    expect(labels(getMemberNav({ capabilities: caps("captain"), hasTelegram: false, hasTeams: false }))).toEqual(["Home", "Register team", "Captain", "Connect Telegram", "Account"]);
  });

  it("Captain appears with the capability only, never from a team or a Telegram link", () => {
    expect(labels(getMemberNav({ capabilities: caps(), hasTelegram: true, hasTeams: true }))).not.toContain("Captain");
    // A set of unknown strings grants nothing either.
    expect(labels(getMemberNav({ capabilities: new Set(["admin", "operator"]) as unknown as ReadonlySet<Capability>, hasTelegram: false, hasTeams: false }))).not.toContain("Captain");
  });

  it("never links anywhere operator-side, and every target is a member route", () => {
    const navs = [
      getMemberNav({ capabilities: caps(), hasTelegram: false, hasTeams: false }),
      getMemberNav({ capabilities: caps(), hasTelegram: true, hasTeams: true }),
      getMemberNav({ capabilities: caps("captain"), hasTelegram: false, hasTeams: true }),
      getMemberNav({ capabilities: caps("captain"), hasTelegram: true, hasTeams: false }),
    ];
    for (const item of navs.flat()) {
      expect(isMemberPath(item.href), item.href).toBe(true);
      expect(item.label).not.toMatch(/admin|operator|people|partners|projects|demo/i);
      expect(item.href).not.toMatch(/^\/hq\/?$|\/hq\/(admin|people|partners|projects|events|demo|select|login)/);
      expect(item.label).not.toMatch(/[—·]/);
    }
    // Keys are render identities: unique within one menu (the team item keeps its key across its two labels).
    for (const nav of navs) expect(new Set(nav.map((item) => item.key)).size).toBe(nav.length);
  });

  it("returns a fresh array each time", () => {
    const input = { capabilities: caps(), hasTelegram: true, hasTeams: true };
    expect(getMemberNav(input)).not.toBe(getMemberNav(input));
  });
});

describe("isNavItemCurrent", () => {
  const item = (activeUnder?: string): NavItem => ({ key: "k", label: "L", href: "/hq/x", ...(activeUnder ? { activeUnder } : {}) });

  it("matches the path itself and the segments below it, never a longer sibling", () => {
    expect(isNavItemCurrent(item("/hq/account"), "/hq/account")).toBe(true);
    expect(isNavItemCurrent(item("/hq/account"), "/hq/account/add-email")).toBe(true);
    expect(isNavItemCurrent(item("/hq/account"), "/hq/accounts")).toBe(false);
    expect(isNavItemCurrent(item("/hq/team/"), "/hq/team/abc")).toBe(true);
    expect(isNavItemCurrent(item("/hq/team/"), "/hq/team")).toBe(false);
    expect(isNavItemCurrent(item("/hq/dashboard"), "/hq/welcome")).toBe(false);
  });

  it("is never current without a section, whatever the path", () => {
    expect(isNavItemCurrent(item(), "/hq/x")).toBe(false);
    expect(isNavItemCurrent(item(), "/hq/account")).toBe(false);
  });

  it("marks exactly one derived item current on each member page", () => {
    const items = getMemberNav({ capabilities: caps("captain"), hasTelegram: false, hasTeams: true });
    const currentOn = (pathname: string) => items.filter((it) => isNavItemCurrent(it, pathname)).map((it) => it.label);
    expect(currentOn("/hq/dashboard")).toEqual(["Home"]);
    expect(currentOn("/hq/team/00000000-0000-4000-8000-00000000000a")).toEqual(["My teams"]);
    expect(currentOn("/hq/captain")).toEqual(["Captain"]);
    expect(currentOn("/hq/account")).toEqual(["Account"]);
    expect(currentOn("/hq/account/connect-telegram")).toEqual(["Account"]);
    // The welcome and join flows belong to no section; with teams, the initialize flow does not either.
    expect(currentOn("/hq/welcome")).toEqual([]);
    expect(currentOn("/hq/join")).toEqual([]);
    expect(currentOn("/hq/initialize")).toEqual([]);
    const registering = getMemberNav({ capabilities: caps(), hasTelegram: false, hasTeams: false });
    expect(registering.filter((it) => isNavItemCurrent(it, "/hq/initialize")).map((it) => it.label)).toEqual(["Register team"]);
    expect(registering.filter((it) => isNavItemCurrent(it, "/hq/dashboard")).map((it) => it.label)).toEqual(["Home"]);
  });
});

describe("BuilderNav and BuilderAccount", () => {
  const state: MemberNavState = { items: getMemberNav({ capabilities: caps("captain"), hasTelegram: false, hasTeams: false }), account: { name: "Fictional Builder" } };
  const render = (node: React.ReactElement, value: MemberNavState = state) => renderToStaticMarkup(withChildren(MemberNavProvider, { value }, node));

  it("renders every item as a link and marks only the current one", () => {
    mocks.pathname = "/hq/captain";
    const html = render(createElement(BuilderNav));
    expect(html).toContain('aria-label="HQ navigation"');
    for (const item of state.items) expect(html).toContain(`href="${item.href}"`);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/hq\/captain"[^>]*>Captain<\/a>|<a[^>]*href="\/hq\/captain"[^>]*aria-current="page"[^>]*>Captain<\/a>/);
    // Connect Telegram and Account share a target; only Account is a section.
    mocks.pathname = "/hq/account";
    const onAccount = render(createElement(BuilderNav));
    expect(onAccount.match(/aria-current="page"/g)).toHaveLength(1);
    expect(onAccount).toMatch(/aria-current="page"[^>]*>Account<\/a>/);
  });

  it("shows the account name with the sign-out control, and nothing operator-side", () => {
    const html = render(createElement(BuilderAccount));
    expect(html).toContain("Fictional Builder");
    expect(html).toMatch(/<button[^>]*>Sign out<\/button>/);
    expect(html.toLowerCase()).not.toMatch(/operator|admin/);
    expect(html).not.toMatch(/[—·]/);
  });

  it("renders nothing without a signed-in member, so the pre-auth screens and a signed-out skeleton carry no menu", () => {
    expect(render(createElement(BuilderNav), null)).toBe("");
    expect(render(createElement(BuilderAccount), null)).toBe("");
    expect(renderToStaticMarkup(createElement(BuilderNav))).toBe("");
  });

  it("the shell carries the nav, the account and an optional Back link, and nothing admin-side", () => {
    mocks.pathname = "/hq/dashboard";
    const content = createElement("p", null, "content");
    const html = render(withChildren(BuilderShell, { back: "/hq/welcome" }, content));
    expect(html).toContain('aria-label="HQ navigation"');
    expect(html).toContain("Fictional Builder");
    expect(html).toMatch(/<a[^>]*href="\/hq\/welcome"[^>]*>Back<\/a>/);
    expect(html).toContain("<p>content</p>");
    expect(html).not.toContain("My HQ");
    expect(html.toLowerCase()).not.toMatch(/operator|hq-chrome|activity/);
    // Without back there is no Back link; the nav's Home covers it.
    expect(render(createElement(BuilderShell, null, content))).not.toContain(">Back<");
  });
});
