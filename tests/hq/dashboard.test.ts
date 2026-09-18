// The operator Dashboard, rendered to static markup: the design's copy and
// type scale, current counts with no target or progress bar beside them, the
// Check-ins banner only while a project is stale, the Forecast bar and legend,
// Milestones and Needs attention rows separated by spacing alone, and none of
// the characters the design forbids.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Dashboard } from "@/components/hq/dashboard";
import type { Classifiers, Milestone, Project, Settings } from "@/lib/hq/types";

const FORBIDDEN = /[—–·]/;

// Wednesday 16 September 2026, noon in Amsterdam.
const NOW = Date.parse("2026-09-16T10:00:00Z");
const TODAY = "2026-09-16";
const TODAY_TEXT = "Wednesday 16 September 2026";

const settings: Settings = {
  prospectsReached: 112,
  committedManual: 14,
  activeAtKickoff: 9,
  staleDays: 7,
  finalistCap: 30,
  verifiedOnlyFinalists: false,
  timezone: "Europe/Amsterdam",
  calStart: "2026-09",
  calEnd: "2026-10",
  prospectsSub: "Builders contacted through partners, events and Telegram",
  activeSub: "Teams that pushed code in kickoff week",
};

const classifiers: Classifiers = {
  channels: [],
  eventTypes: [],
  roles: [],
  stages: [],
  statuses: [],
  forecasts: [
    { id: "f1", slug: "committed", label: "Committed", color: "green" },
    { id: "f2", slug: "likely", label: "Likely", color: "orange" },
    { id: "f3", slug: "at-risk", label: "At risk", color: "red" },
  ],
  gates: [
    { id: "g1", label: "Repo public" },
    { id: "g2", label: "Demo video" },
  ],
  exchangeItems: [],
};

function project(overrides: Partial<Project> & { id: string; name: string }): Project {
  return {
    leadName: "",
    leadContact: "",
    members: [],
    partnerId: null,
    partnerName: "",
    captainUserId: null,
    captainName: "",
    eventSrc: "",
    statusSlug: "green",
    forecastSlug: "committed",
    gates: [],
    lastCheckIn: "2026-09-15",
    blocker: "",
    touchedBy: "",
    touchedAt: null,
    notes: [],
    ...overrides,
  };
}

const projects: Project[] = [
  project({ id: "p1", name: "Grachtenpay", statusSlug: "amber", forecastSlug: "likely", blocker: "waiting on Helius RPC quota upgrade", lastCheckIn: "2026-09-16", gates: ["g1", "g2"] }),
  project({ id: "p2", name: "Kaasketen", statusSlug: "red", forecastSlug: "at-risk", blocker: "lead unreachable since kickoff, team of one", lastCheckIn: "2026-09-05" }),
  project({ id: "p3", name: "Fietsroute", statusSlug: "red", forecastSlug: "at-risk", lastCheckIn: "2026-09-07" }),
  project({ id: "p4", name: "Windmolen DAO", statusSlug: "amber", blocker: "needs a frontend dev, posted in Telegram", lastCheckIn: "2026-09-15" }),
  project({ id: "p5", name: "Stroopwafel Swap", statusSlug: "amber", lastCheckIn: "2026-09-14", gates: ["g1"] }),
  project({ id: "p6", name: "Tulip Ledger", lastCheckIn: "2026-09-16", gates: ["g1", "g2"] }),
];

const milestones: Milestone[] = [
  { id: "m1", date: "2026-09-14", label: "Kickoff Amsterdam" },
  { id: "m2", date: "2026-09-23", label: "Rotterdam Build Night" },
  { id: "m3", date: "2026-10-12", label: "Colosseum submissions close" },
];

function render(overrides: Partial<Parameters<typeof Dashboard>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(Dashboard, {
      settings,
      projects,
      milestones,
      classifiers,
      now: NOW,
      todayIso: TODAY,
      todayText: TODAY_TEXT,
      ...overrides,
    }),
  );
}

/** The text of every element whose inline style carries `fontSize`, in document order. */
function textsAt(html: string, fontSize: number): string[] {
  return [...html.matchAll(new RegExp(`<[a-z0-9]+ style="[^"]*font-size:${fontSize}px[^"]*">([^<]*)<`, "g"))].map((m) => m[1]);
}

describe("Dashboard", () => {
  it("heads the page with the serif title and the date line", () => {
    const html = render();
    expect(html).toMatch(/<h1 style="font-family:var\(--serif\);font-size:44px;font-weight:400;letter-spacing:-0.01em;margin:0">Dashboard<\/h1>/);
    expect(html).toContain(`<span style="font-size:16px;color:var(--label-3)">${TODAY_TEXT}</span>`);
    expect(html).not.toMatch(FORBIDDEN);
  });

  it("shows the four funnel counts as current numbers with no target, bar or glide path", () => {
    const html = render();
    const labels = ["Prospects reached", "Committed projects", "Active at kickoff", "Verified submissions"].map(
      (label) => html.indexOf(`<div style="font-size:16px;color:var(--label-2)">${label}</div>`),
    );
    expect(labels.every((index, i) => index > (labels[i - 1] ?? -1))).toBe(true);
    expect(textsAt(html, 40)).toEqual(["112", "14", "9", "2"]);
    expect(textsAt(html, 14).slice(0, 4)).toEqual([
      "Builders contacted through partners, events and Telegram",
      "3 of 6 tracked here are committed",
      "Teams that pushed code in kickoff week",
      "Every submission gate checked",
    ]);
    expect(html).toContain("repeat(auto-fit,minmax(264px,1fr))");
    expect(html).not.toContain("/ ");
    expect(html).not.toMatch(/target|glide|Monday review|height:4px/);
  });

  it("names the stale projects in the Check-ins banner, and drops it when every project has checked in", () => {
    const html = render();
    expect(html).toContain('<span style="font-size:16px;font-weight:600;color:var(--orange);white-space:nowrap">Check-ins</span>');
    expect(html).toContain("2 projects have no check-in for over a week: Kaasketen, Fietsroute.");
    expect(html).toMatch(/background:var\(--orange-fill\);padding:10px 14px/);

    const one = render({ projects: projects.filter((p) => p.id !== "p3") });
    expect(one).toContain("1 project has no check-in for over a week: Kaasketen.");

    const fresh = render({ projects: projects.filter((p) => !["p2", "p3"].includes(p.id)) });
    expect(fresh).not.toContain("Check-ins");
    expect(fresh).not.toContain("var(--orange-fill)");
  });

  it("draws the Forecast bar and legend from the tracked projects, with no subtitle", () => {
    const html = render();
    expect(html).toContain('<h2 style="font-family:var(--serif);font-size:26px;font-weight:400;margin:0">Forecast</h2>');
    expect(html).not.toContain("Across the");
    expect(html).toContain('<div style="background:var(--green);width:50%"></div>');
    expect(html).toContain(`<div style="background:var(--orange);width:${(1 / 6) * 100}%"></div>`);
    expect(html).toContain(`<div style="background:var(--red);width:${(2 / 6) * 100}%"></div>`);
    expect(html).toContain("repeat(auto-fit,minmax(min(360px,100%),1fr))");
    for (const [label, count] of [["Committed", "3"], ["Likely", "1"], ["At risk", "2"]]) {
      expect(html).toContain(`<span style="font-size:16px;color:var(--label-2)">${label}</span><span style="font-size:16px;font-weight:600;font-variant-numeric:tabular-nums">${count}</span>`);
    }
  });

  it("lists the milestones with their date and countdown", () => {
    const html = render();
    expect(html).toContain(">Milestones</h2>");
    expect(textsAt(html, 17).slice(0, 3)).toEqual(["Kickoff Amsterdam", "Rotterdam Build Night", "Colosseum submissions close"]);
    for (const [date, until] of [["Sep 14", "2d ago"], ["Sep 23", "in 7d"], ["Oct 12", "in 26d"]]) {
      expect(html).toMatch(new RegExp(`>${date}</span><span style="font-size:17px;flex:1">[^<]+</span><span style="[^"]*color:var\\(--accent-deep\\)[^"]*">${until}</span>`));
    }
  });

  it("puts red projects first under Needs attention, then amber ones with a blocker", () => {
    const html = render();
    expect(html).toContain(">Needs attention</h2>");
    expect(textsAt(html, 17).slice(3)).toEqual([
      "Kaasketen: lead unreachable since kickoff, team of one",
      "Fietsroute: red status, no blocker noted",
      "Grachtenpay: waiting on Helius RPC quota upgrade",
      "Windmolen DAO: needs a frontend dev, posted in Telegram",
    ]);
    expect(textsAt(html, 14).slice(4)).toEqual([
      "last check-in Sep 5",
      "last check-in Sep 7",
      "last check-in Sep 16",
      "last check-in Sep 15",
    ]);
    expect(html.match(/border-radius:999px;background:var\(--red\)/g)).toHaveLength(2);
    expect(html.match(/border-radius:999px;background:var\(--orange\)/g)).toHaveLength(2);
    expect(html).not.toContain("Stroopwafel Swap");
    expect(html).not.toContain("Tulip Ledger");
  });

  it("separates rows and cards by spacing, never rule lines", () => {
    const html = render();
    expect(html).not.toContain("border-bottom");
    expect(html.match(/box-shadow:var\(--shadow-1\);padding:24px;margin-top:0"/g)).toHaveLength(6);
    expect(html.match(/box-shadow:var\(--shadow-1\);padding:24px;margin-top:28px/g)).toHaveLength(1);
  });

  it("renders every list empty without copy of its own", () => {
    const html = render({ projects: [], milestones: [] });
    expect(html).toContain(">Milestones</h2>");
    expect(html).toContain(">Needs attention</h2>");
    expect(html).toContain("0 of 0 tracked here are committed");
    expect(html).not.toContain("Check-ins");
    expect(html).not.toMatch(/No |Nothing|yet/);
    expect(html).not.toMatch(FORBIDDEN);
  });
});
