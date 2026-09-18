// The operator Events screen, rendered to static markup: the header row and
// its toolbar, the Luma freshness pill and sync button titles, the list's
// column headers, the rows in date order with the design's copy for ranges,
// upcoming rows and outputs, the per-row action that fits the row's source,
// the separator cleanup, the operator type floor and none of the characters
// the design forbids. The calendar and the edit row live behind state a
// static render cannot reach.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Classifiers, HqEvent } from "@/lib/hq/types";

// The screen refreshes the route after a Cmd-K arrival; static markup needs
// the hook to exist, not to navigate.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {}, replace() {} }),
}));
// The event actions carry the database imports; static markup needs their
// names, not their effects.
vi.mock("@/lib/hq/actions/events", () => ({
  archiveEvent: vi.fn(),
  createEvent: vi.fn(),
  deleteEvent: vi.fn(),
  syncLuma: vi.fn(),
  unarchiveEvent: vi.fn(),
  unpinEventField: vi.fn(),
  updateEvent: vi.fn(),
}));

import { Events } from "@/components/hq/events";

const FORBIDDEN = /[—–·]/;
const TODAY = "2026-09-16";
const NOW = Date.parse("2026-09-16T12:00:00Z");
const HOUR = 60 * 60 * 1000;

const classifiers: Classifiers = {
  channels: [],
  eventTypes: [
    { id: "t1", label: "Multi-day program", supportsEndDate: true },
    { id: "t3", label: "Workshop", supportsEndDate: false },
    { id: "t6", label: "Online session", supportsEndDate: false },
  ],
  roles: [],
  stages: [],
  statuses: [],
  forecasts: [],
  gates: [],
  exchangeItems: [],
};

function event(over: Partial<HqEvent> & Pick<HqEvent, "id" | "name" | "date">): HqEvent {
  return {
    endDate: null,
    typeId: "t3",
    venue: "",
    cohost: "",
    attendance: 0,
    leads: 0,
    spend: 0,
    lumaId: null,
    lumaUrl: "",
    pinned: [],
    archived: false,
    archivedReason: null,
    outputs: { q: 0, a: 0, s: 0 },
    ...over,
  };
}

const kickoff = event({
  id: "e1",
  name: "Kickoff Amsterdam",
  date: "2026-09-14",
  venue: "A Lab, Amsterdam",
  cohost: "Solana Foundation EU",
  attendance: 84,
  leads: 21,
  spend: 1800,
  lumaId: "evt-1",
  lumaUrl: "https://lu.ma/stnl-kickoff",
  pinned: ["venue"],
  outputs: { q: 9, a: 6, s: 1 },
});
const anchor = event({
  id: "e4",
  name: "Anchor deep dive (online)",
  date: "2026-09-25",
  typeId: "t6",
  venue: "Zoom",
});
const utrecht = event({
  id: "e5",
  name: "Utrecht Student Hack",
  date: "2026-10-02",
  endDate: "2026-10-04",
  typeId: "t1",
  venue: "Utrecht Science Park",
  cohost: "TU Delft Blockchain Lab",
  spend: 2400,
  lumaId: "evt-5",
  lumaUrl: "https://lu.ma/stnl-utrecht",
});
const recap = event({
  id: "e8",
  name: "Breakout recap (cancelled)",
  date: "2026-08-20",
  lumaId: "evt-8",
  lumaUrl: "https://lu.ma/stnl-recap",
  archived: true,
  archivedReason: "manual",
});

function screen(events: HqEvent[], syncedAt: string | null = new Date(NOW - 5 * HOUR).toISOString()) {
  return renderToStaticMarkup(
    createElement(Events, {
      events,
      classifiers,
      settings: { calStart: "2026-09", calEnd: "2026-10" },
      now: NOW,
      today: TODAY,
      syncedAt,
    }),
  );
}

/** The text of the tag that contains `needle`, or "" when it is not there. */
function tagWith(html: string, needle: string): string {
  return html.match(new RegExp(`<[^<>]*${needle}[^<>]*>`))?.[0] ?? "";
}

describe("the Events screen", () => {
  it("heads the page with the active count, the view toggle, the archived toggle and New event", () => {
    const html = screen([kickoff, anchor, utrecht, recap]);
    expect(html).toMatch(/<h1[^>]*>Events <span[^>]*>3<\/span><\/h1>/);
    expect(html).toMatch(/<button type="button" aria-pressed="true"[^>]*>List<\/button>/);
    expect(html).toMatch(/<button type="button" aria-pressed="false"[^>]*>Calendar<\/button>/);
    expect(html).toMatch(/<button type="button" aria-pressed="false"[^>]*>Archived 1<\/button>/);
    expect(html).toMatch(/<button type="button" aria-expanded="false"[^>]*>New event<\/button>/);
    expect(html).not.toContain("Archived events are hidden");
    expect(html).not.toContain("Event name");
    expect(html).not.toMatch(FORBIDDEN);
  });

  it("leaves the archived toggle out while nothing is archived", () => {
    const html = screen([kickoff, anchor, utrecht]);
    expect(html).not.toContain(">Archived");
    expect(html).toMatch(/<h1[^>]*>Events <span[^>]*>3<\/span><\/h1>/);
  });

  it("surfaces the last Luma sync once it is older than three hours, and never a missing one", () => {
    const stale = screen([kickoff]);
    expect(stale).toContain(">Updated 5h ago</span>");
    expect(stale).toContain(
      'title="Luma events last synced 5h ago. Use the refresh button to sync now."',
    );
    expect(stale).toMatch(
      /<button type="button" aria-busy="false" aria-label="Sync Luma events now - last synced 5h ago" title="Sync Luma events now - last synced 5h ago"/,
    );

    const fresh = screen([kickoff], new Date(NOW - HOUR).toISOString());
    expect(fresh).not.toContain("Updated 1h ago");
    expect(fresh).toContain('title="Sync Luma events now - last synced 1h ago"');

    const never = screen([kickoff], null);
    expect(never).toContain(">Not updated yet</span>");
    expect(never).toContain('title="Luma events never synced. Use the refresh button to sync now."');
    expect(never).toContain('title="Sync Luma events now - never synced"');
  });

  it("lists the nine columns in order, with the output tooltip on the last", () => {
    const html = screen([kickoff]);
    // The plain column headers are the only unstyled spans on the page.
    const headers = [...html.matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(headers).toEqual(["Date", "Event", "Type", "Venue", "Cohost", "Attend", "Leads", "Spend"]);
    const output = tagWith(html, "Qualified teams / active teams / verified submissions");
    expect(output).toContain("cursor:help");
    expect(html.indexOf(output)).toBeGreaterThan(html.indexOf("<span>Spend</span>"));
    expect(html).toContain(`${output}Output q / a / s</span>`);
  });

  it("orders rows newest first, skips archived ones and says 'to' between the ends of a range", () => {
    const html = screen([kickoff, anchor, utrecht, recap]);
    const at = (name: string) => html.indexOf(name);
    expect(at("Utrecht Student Hack")).toBeGreaterThan(0);
    expect(at("Utrecht Student Hack")).toBeLessThan(at("Anchor deep dive (online)"));
    expect(at("Anchor deep dive (online)")).toBeLessThan(at("Kickoff Amsterdam"));
    expect(html).not.toContain("Breakout recap");
    expect(html).toContain(">Oct 2 to Oct 4</span>");
    expect(html).toContain(">Sep 25</span>");
    expect(html).toContain(">Sep 14</span>");
    expect(html).not.toMatch(FORBIDDEN);
  });

  it("shows attendance, leads and outputs for a past event and 'upcoming' for the rest", () => {
    const html = screen([kickoff, anchor, utrecht]);
    expect(html).toContain(">84</span>");
    expect(html).toContain(">21</span>");
    expect(html).toContain(">$1,800</span>");
    expect(html).toContain(">9 / 6 / 1</span>");
    expect(html).toContain(">$2,400</span>");
    expect(html.match(/>upcoming<\/span>/g)).toHaveLength(2);
    expect(html).toContain(">Workshop</span>");
    expect(html).toContain(">Multi-day program</span>");
    expect(html).toContain(">A Lab, Amsterdam</span>");
    expect(html).toContain(">TU Delft Blockchain Lab</span>");
  });

  it("marks Luma events with the wordmark link and offers Archive, while a hand-made one gets Delete", () => {
    const html = screen([kickoff, anchor, utrecht]);
    expect(html.match(/aria-label="View on Luma"/g)).toHaveLength(2);
    expect(html).toMatch(
      /<a class="hq-hover-accent" href="https:\/\/lu\.ma\/stnl-kickoff" target="_blank" rel="noreferrer" title="View on Luma" aria-label="View on Luma"/,
    );
    expect(html.match(/>Edit<\/button>/g)).toHaveLength(3);
    expect(html.match(/>Archive<\/button>/g)).toHaveLength(2);
    expect(html).toMatch(/<button type="button" class="hq-hover-accent" title="Delete"[^>]*>Delete<\/button>/);
    expect(html).not.toContain("Unarchive");
    expect(html).not.toContain("Sure?");
    expect(html).not.toContain("Overriding Luma");
  });

  it("keeps the header underline as the only rule line, and no type below the design's floor", () => {
    const html = screen([kickoff, anchor, utrecht]);
    expect(html.match(/border-bottom:1px solid var\(--sep\)/g)).toHaveLength(1);
    expect(html).not.toMatch(/border-top|<hr/);
    expect(html).not.toMatch(/font-size:(?:[0-9]|1[0-3])px/);
    expect(html).toContain("font-size:44px");
    expect(html).toContain("font-size:17px");
  });
});
