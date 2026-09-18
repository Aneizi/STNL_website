// The hackathon picker (/hq/select), rendered to static markup: the title
// and kicker, one banner per open edition with the "Current" badge on the
// remembered one, the Archived list with its rows on the operator type scale
// and no rule lines, the footer, the empty-database form, and none of the
// characters the design forbids.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Hackathon } from "@/lib/hq/types";

// The picker's server actions carry the database imports; static markup
// needs their names, not their effects.
vi.mock("@/lib/hq/actions/auth", () => ({ logout: vi.fn() }));
vi.mock("@/lib/hq/actions/hackathons", () => ({ chooseHackathon: vi.fn(), createHackathon: vi.fn() }));

import { HackathonPicker } from "@/components/hq/hackathon-picker";

const worldsFair: Hackathon = {
  id: 6,
  slug: "colosseum-worlds-fair",
  name: "Colosseum Crypto World's Fair",
  startDate: "2026-09-14",
  endDate: "2026-10-12",
  archived: false,
};
const radar: Hackathon = {
  id: 7,
  slug: "colosseum-radar",
  name: "Colosseum Radar",
  startDate: "2026-11-02",
  endDate: "2026-11-30",
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

function picker(hackathons: Hackathon[], selectedId: number | null = worldsFair.id, displayName = "Nienke") {
  return renderToStaticMarkup(createElement(HackathonPicker, { hackathons, selectedId, displayName }));
}

/** The archived row's submit button, as one tag with its children. */
function archivedRow(html: string, name: string): string {
  const match = html.match(new RegExp(`<button[^>]*aria-label="Open ${name}, archived"[^>]*>[\\s\\S]*?</button>`));
  expect(match, `archived row for ${name}`).not.toBeNull();
  return match![0];
}

describe("HackathonPicker", () => {
  it("shows the title, the kicker and the footer, with nothing the design forbids", () => {
    const html = picker([worldsFair, breakout]);
    expect(html).toContain("Superteam <em");
    expect(html).toMatch(/<em[^>]*>HQ<\/em>/);
    expect(html).toContain("Choose a hackathon");
    expect(html).not.toContain("No hackathons yet");
    expect(html).toContain("Signed in as Nienke");
    expect(html).toMatch(/<span[^>]*>\/<\/span>/);
    expect(html).toMatch(/<button type="button" class="hq-hover-accent"[^>]*>Sign out<\/button>/);
    expect(html).not.toMatch(FORBIDDEN);
  });

  it("renders one banner form per open edition, dressed when it has artwork and typographic when it has none", () => {
    const html = picker([worldsFair, radar, breakout]);
    expect(html).toContain('<input type="hidden" name="hackathon" value="6"/>');
    expect(html).toContain('<input type="hidden" name="hackathon" value="7"/>');
    expect(html).toContain(
      'aria-label="Open Colosseum Crypto World&#x27;s Fair, September 14 to October 12, 2026"',
    );
    expect(html).toContain('aria-label="Open Colosseum Radar, November 2 to 30, 2026"');
    expect(html).toContain('alt="Crypto World&#x27;s Fair"');
    expect(html).toContain('class="hq-banner hq-banner-art"');
    expect(html).toContain('class="hq-banner-shade"');
    expect(html).toContain('class="hq-banner-dates">September 14 to October 12, 2026</span>');
    expect(html).toContain('class="hq-banner-plain"');
    expect(html).toContain('class="hq-banner-name">Colosseum Radar</span>');
    expect(html.indexOf("Colosseum Radar")).toBeLessThan(html.indexOf("Archived"));
  });

  it("badges only the remembered edition as Current", () => {
    const html = picker([worldsFair, radar, breakout], worldsFair.id);
    expect(html.match(/class="hq-banner-current"/g)).toHaveLength(1);
    expect(html.indexOf('class="hq-banner-current"')).toBeLessThan(html.indexOf("Colosseum Radar"));
    expect(picker([worldsFair, radar, breakout], null)).not.toContain("Current");
  });

  it("lists archived editions after the banners as compact rows without rule lines", () => {
    const html = picker([worldsFair, breakout]);
    expect(html.indexOf("hq-banner")).toBeLessThan(html.indexOf("Archived"));
    expect(html.indexOf("Archived")).toBeLessThan(html.indexOf("Colosseum Breakout"));
    const row = archivedRow(html, "Colosseum Breakout");
    expect(row).toMatch(/^<button type="submit" class="hq-hover-fill"/);
    expect(row).toContain("padding:11px 14px");
    expect(row).not.toContain("border-bottom");
    expect(row).toContain('<span style="font-size:17px;font-weight:600;color:var(--label-1)">Colosseum Breakout</span>');
    expect(row).toContain('<span style="font-size:14px;color:var(--label-3);flex:1">April 14 to May 16, 2026</span>');
    expect(row).toContain('<span style="font-size:14px;font-weight:600;color:var(--label-2)">Open</span>');
    expect(row).not.toContain("Current");
    expect(html).toContain('<input type="hidden" name="hackathon" value="5"/>');
  });

  it("tags an archived row that is still the remembered edition", () => {
    const row = archivedRow(picker([worldsFair, breakout], breakout.id), "Colosseum Breakout");
    expect(row).toMatch(/<span style="font-size:12px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:var\(--accent\)">Current<\/span>/);
    expect(row.indexOf("May 16, 2026")).toBeLessThan(row.indexOf("Current"));
    expect(row.indexOf("Current")).toBeLessThan(row.indexOf(">Open<"));
  });

  it("leaves the Archived block out when every edition is open", () => {
    const html = picker([worldsFair, radar]);
    expect(html).not.toContain("Archived");
    expect(html).not.toContain("hq-hover-fill");
  });

  it("offers the first-hackathon form, and no banner, when the database has none", () => {
    const html = picker([], null);
    expect(html).toContain("No hackathons yet");
    expect(html).not.toContain("Choose a hackathon");
    expect(html).not.toContain("hq-banner");
    expect(html).not.toContain("Archived");
    expect(html).toContain('<div style="font-family:var(--serif);font-size:28px">Add the first hackathon</div>');
    expect(html).toMatch(/<div style="font-size:16px;color:var\(--label-2\);margin-top:4px">Everything in HQ belongs to a hackathon\./);
    for (const label of ["ID", "Name", "Starts", "Ends"]) expect(html).toContain(`>${label}<`);
    expect(html).toMatch(/<button type="button"[^>]*>Add<\/button>/);
    expect(html).not.toMatch(FORBIDDEN);
  });
});
