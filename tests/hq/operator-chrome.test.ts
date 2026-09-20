// The operator chrome, rendered to static markup: the five section tabs in
// order with the Links tab gone, which route lights which tab, the account
// menu and hackathon switcher closed and (the switcher) open, and none of
// the characters the design forbids.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Hackathon } from "@/lib/hq/types";

const mocks = vi.hoisted(() => ({ pathname: "/hq" }));
vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push() {}, refresh() {}, replace() {} }),
}));
// The chrome's server actions carry the database imports; static markup
// needs their names, not their effects.
vi.mock("@/lib/hq/actions/auth", () => ({ logout: vi.fn() }));
vi.mock("@/lib/hq/actions/hackathons", () => ({ switchHackathon: vi.fn() }));
vi.mock("@/lib/hq/actions/overlay", () => ({ fetchActivity: vi.fn() }));
// The icon package ships its source; the stand-in renders the props it is
// given, so the fill="currentColor" convention is still asserted.
vi.mock("symbols-react", () => ({
  IconChevronDown: (props: Record<string, unknown>) => createElement("svg", props),
}));

import { activeTab, HqChrome } from "@/components/hq/chrome";
import { HackathonSwitcher } from "@/components/hq/hackathon-switcher";

const radar: Hackathon = {
  id: 6,
  slug: "colosseum-radar",
  name: "Colosseum Radar",
  startDate: "2026-09-14",
  endDate: "2026-10-12",
  archived: false,
};
const breakout: Hackathon = {
  id: 5,
  slug: "colosseum-breakout",
  name: "Colosseum Breakout",
  startDate: "2026-04-14",
  endDate: "2026-05-16",
  archived: true,
};
const FORBIDDEN = /[—–·]/;

function chrome(pathname: string, selectedId: number | null = radar.id, displayName = "Nienke") {
  mocks.pathname = pathname;
  return renderToStaticMarkup(
    createElement(HqChrome, { displayName, hackathons: [radar, breakout], selectedId }),
  );
}

function switcher(hackathons: Hackathon[], selectedId: number | null, open: boolean) {
  return renderToStaticMarkup(
    createElement(HackathonSwitcher, { hackathons, selectedId, open, onOpenChange() {} }),
  );
}

/** The tab anchors in document order, as [label, whole tag]. */
function tabs(html: string): Array<[string, string]> {
  return [...html.matchAll(/(<a[^>]*class="hq-chrome-tab[^"]*"[^>]*>)([^<]+)<\/a>/g)].map((m) => [
    m[2],
    m[1],
  ]);
}

describe("HqChrome", () => {
  it("shows the five section tabs in order, separated by slashes, with no Links tab", () => {
    const html = chrome("/hq");
    expect(tabs(html).map(([label]) => label)).toEqual([
      "Dashboard",
      "Projects",
      "Partners",
      "People",
      "Events",
    ]);
    expect(html.match(/>\/<\/span>/g)).toHaveLength(4);
    expect(html).not.toContain("Links");
    expect(html).not.toContain("/hq/links");
    expect(html).not.toMatch(FORBIDDEN);
  });

  it("lights the tab for the route: Demo day keeps Projects lit, Admin lights nothing", () => {
    expect(activeTab("/hq")).toBe("/hq");
    expect(activeTab("/hq/projects")).toBe("/hq/projects");
    expect(activeTab("/hq/demo")).toBe("/hq/projects");
    expect(activeTab("/hq/partners")).toBe("/hq/partners");
    expect(activeTab("/hq/partners/abc")).toBe("/hq/partners");
    expect(activeTab("/hq/people")).toBe("/hq/people");
    expect(activeTab("/hq/events")).toBe("/hq/events");
    expect(activeTab("/hq/admin")).toBeNull();
    expect(activeTab("/hq/select")).toBeNull();

    const byLabel = Object.fromEntries(tabs(chrome("/hq/demo")));
    expect(byLabel.Projects).toContain("hq-chrome-tab-active");
    expect(byLabel.Projects).toContain('aria-current="page"');
    expect(byLabel.Dashboard).not.toContain("hq-chrome-tab-active");
    expect(byLabel.Dashboard).not.toContain("aria-current");
    for (const [, tag] of tabs(chrome("/hq/admin"))) expect(tag).not.toContain("hq-chrome-tab-active");
  });

  it("offers search, the activity drawer and a closed account menu", () => {
    const html = chrome("/hq");
    expect(html).toContain('title="Search (Cmd-K)"');
    expect(html).toContain("⌘K");
    expect(html).toContain(">Activity</button>");
    expect(html).toMatch(
      /<button type="button" title="Nienke" aria-haspopup="menu" aria-expanded="false"[^>]*>N<\/button>/,
    );
    expect(html).not.toContain("Operator");
    expect(html).not.toContain("Sign out");
    expect(html).not.toContain("/hq/admin");
  });

  it("falls back to a question mark for an empty display name", () => {
    expect(chrome("/hq", radar.id, "")).toMatch(/aria-expanded="false"[^>]*>\?<\/button>/);
  });

  it("names the hackathon being shown in the switcher, with no pill for an archived one", () => {
    expect(chrome("/hq", radar.id)).toContain("Colosseum Radar");
    const archived = chrome("/hq", breakout.id);
    expect(archived).toContain("Colosseum Breakout");
    expect(archived).not.toContain("Archived");
    expect(chrome("/hq", null)).toContain("Choose a hackathon");
  });
});

describe("HackathonSwitcher", () => {
  it("is a closed menu button by default", () => {
    const html = switcher([radar, breakout], radar.id, false);
    expect(html).toMatch(/<button type="button" title="Switch hackathon" aria-haspopup="menu" aria-expanded="false"/);
    expect(html).toContain('fill="currentColor"');
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain("All hackathons");
  });

  it("lists open editions, then the archived ones under a header, then the two footer links", () => {
    const html = switcher([radar, breakout], radar.id, true);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('role="menu"');
    expect(html.indexOf("Colosseum Radar")).toBeLessThan(html.indexOf("Archived"));
    expect(html.indexOf("Archived")).toBeLessThan(html.indexOf("Colosseum Breakout"));
    expect(html).toContain("September 14 to October 12, 2026<span");
    expect(html).toContain("> #6</span>");
    expect(html).toContain("April 14 to May 16, 2026<span");
    expect(html).toContain("> #5</span>");
    expect(html).toMatch(/<button[^>]*role="menuitemradio" aria-checked="true"[^>]*>(?:(?!<\/button>)[\s\S])*Colosseum Radar/);
    expect(html).toMatch(/<a[^>]*href="\/hq\/select"[^>]*>All hackathons<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/hq\/admin"[^>]*>Manage hackathons<\/a>/);
    expect(html.indexOf("All hackathons")).toBeLessThan(html.indexOf("Manage hackathons"));
    expect(html).not.toMatch(FORBIDDEN);
  });

  it("leaves the Archived header out when every edition is open", () => {
    const html = switcher([radar], radar.id, true);
    expect(html).toContain("Colosseum Radar");
    expect(html).not.toContain("Archived");
  });
});
