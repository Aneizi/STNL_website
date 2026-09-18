// The Partners board and the Partner detail page, rendered to static markup:
// the board's stage columns in classifier order with the two outcome columns
// stacked and tinted, every card a draggable link to its detail page, and the
// detail page's header, details grid, last-touched line and three cards, with
// the copy the design sets and none of the characters it forbids.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Classifiers, Partner, PartnerDetail as PartnerDetailData } from "@/lib/hq/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {}, replace() {} }),
}));
// The actions carry the database imports; static markup needs their names.
vi.mock("@/lib/hq/actions/partners", () => ({
  addPartnerContact: vi.fn(),
  createPartner: vi.fn(),
  deletePartner: vi.fn(),
  setPartnerStage: vi.fn(),
  togglePartnerExchange: vi.fn(),
  updatePartnerDetail: vi.fn(),
}));

import { PartnerDetail } from "@/components/hq/partner-detail";
import { PartnersBoard } from "@/components/hq/partners-board";

const FORBIDDEN = /[—–·]/;

const classifiers: Classifiers = {
  channels: [
    { id: "ch1", label: "University" },
    { id: "ch2", label: "Ecosystem" },
    { id: "ch3", label: "Corporate" },
  ],
  eventTypes: [],
  roles: [],
  stages: [
    { id: "st1", slug: "draft", label: "Draft", dropColor: "#8a8579" },
    { id: "st2", slug: "sent", label: "Sent", dropColor: "#a8760f" },
    { id: "st3", slug: "call", label: "Replied", dropColor: "#ee5b23" },
    { id: "st4", slug: "agreed", label: "Agreed", dropColor: "#3e7c4f" },
    { id: "st5", slug: "rejected", label: "Rejected", dropColor: "#c03b2d" },
  ],
  statuses: [
    { id: "s1", slug: "green", label: "Green", color: "green", countsAsActive: true },
    { id: "s2", slug: "amber", label: "Amber", color: "orange", countsAsActive: true },
    { id: "s3", slug: "red", label: "Red", color: "red", countsAsActive: false },
  ],
  forecasts: [],
  gates: [],
  exchangeItems: [
    { id: "x1", slug: "mailing", label: "Communicated with community members" },
    { id: "x2", slug: "event", label: "Event cohosted" },
    { id: "x3", slug: "captain", label: "Captain named" },
    { id: "x4", slug: "weekly", label: "Weekly follow-up active" },
  ],
};

const partner = (over: Partial<Partner> & Pick<Partner, "id" | "name" | "stageSlug">): Partner => ({
  channelId: "ch1",
  channelLabel: "University",
  captainName: "Femke de Jong",
  captainContact: "f.dejong@tudelft.nl",
  target: 6,
  attributed: 3,
  exchange: ["x1", "x3"],
  touchedBy: "Nienke",
  touchedAt: "2026-09-16",
  ...over,
});

const delft = partner({ id: "pt1", name: "TU Delft Blockchain Lab", stageSlug: "agreed" });
const partners: Partner[] = [
  delft,
  partner({
    id: "pt2",
    name: "Dutch Blockchain Coalition",
    stageSlug: "call",
    channelId: "ch2",
    channelLabel: "Ecosystem",
    captainName: "Rutger Bos",
    target: 8,
    attributed: 2,
  }),
  partner({
    id: "pt7",
    name: "Antler Amsterdam",
    stageSlug: "draft",
    channelId: "ch3",
    channelLabel: "Corporate",
    captainName: "",
    target: 4,
    attributed: 0,
  }),
];

const detail: PartnerDetailData = {
  ...delft,
  contacts: [
    {
      id: "n1",
      author: "Nienke",
      body: "Femke confirmed the lab will host office hours every Tuesday.",
      createdAt: "2026-09-15T09:20:00.000Z",
    },
    { id: "n2", author: "Bram", body: "Sent the partnership one-pager.", createdAt: "2026-09-02T07:40:00.000Z" },
  ],
  teams: [
    { id: "t1", name: "Windmolen DAO", statusSlug: "amber" },
    { id: "t2", name: "Polderproof", statusSlug: "green" },
  ],
};

const board = (list: Partner[] = partners) =>
  renderToStaticMarkup(createElement(PartnersBoard, { partners: list, classifiers }));

const page = (data: PartnerDetailData = detail) =>
  renderToStaticMarkup(
    createElement(PartnerDetail, {
      partner: data,
      classifiers,
      timezone: "Europe/Amsterdam",
      userName: "Nienke",
    }),
  );

/** The board's column labels in document order. */
const columns = (html: string) =>
  [...html.matchAll(/text-transform:uppercase;letter-spacing:0\.08em">([^<]+)<\/span><span[^>]*>(\d+)<\/span>/g)].map(
    (m) => `${m[1]} ${m[2]}`,
  );

describe("PartnersBoard", () => {
  it("heads the page with the count and a New partner control, the form closed", () => {
    const html = board();
    expect(html).toMatch(/<h1[^>]*>Partners <span[^>]*>3<\/span><\/h1>/);
    expect(html).toMatch(/<button type="button"[^>]*>New partner<\/button>/);
    expect(html).not.toContain("tg, x, or email");
    expect(html).not.toContain(">Add<");
    expect(html).not.toContain('role="alert"');
  });

  it("lays out the stages in classifier order, with Agreed over Rejected in the last cell, tinted", () => {
    const html = board();
    expect(columns(html)).toEqual(["Draft 1", "Sent 0", "Replied 1", "Agreed 1", "Rejected 0"]);
    expect(html).toContain("background:var(--green-fill)");
    expect(html).toContain("background:var(--red-fill)");
    expect(html).toContain("flex:1 1 0");
    expect(html).toContain("grid-template-columns:repeat(auto-fit,minmax(288px,1fr))");
    // Separation is by spacing alone: no rule line under a column header.
    expect(html).not.toContain("border-bottom");
  });

  it("renders every card as a draggable link to its detail page, in the page colour", () => {
    const html = board();
    const card = html.match(/<a [^>]*href="\/hq\/partners\/pt1"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
    expect(card).toContain('draggable="true"');
    expect(card).toContain('class="hq-card-link hq-card-hover hq-drop-flash"');
    expect(card).toContain("color:inherit");
    expect(card).toContain("text-decoration:none");
    expect(card).toContain("--hq-drop-color:#3e7c4f");
    expect(card).toMatch(/font-size:17px;font-weight:600">TU Delft Blockchain Lab</);
    expect(card).toContain(">3/6</span>");
    expect(card).toContain(">University</div>");
    expect(card).toContain(">Femke de Jong</div>");
    expect(html).toContain('href="/hq/partners/pt2"');
    expect(html).toContain('href="/hq/partners/pt7"');
    expect(card).not.toContain("<button");
  });

  it("uses no em dash, en dash or middot, and the stylesheet resets the link hover for cards", () => {
    expect(board()).not.toMatch(FORBIDDEN);
    expect(board([])).not.toMatch(FORBIDDEN);
    const css = readFileSync(join(process.cwd(), "app/hq/hq.css"), "utf8");
    expect(css).toMatch(/\.hq \.hq-card-link:hover \{\s*text-decoration: none;\s*color: inherit;\s*\}/);
  });
});

describe("PartnerDetail", () => {
  it("heads the page with the back link, the name, the stage badge and the Edit and Delete controls", () => {
    const html = page();
    expect(html).toMatch(/<a [^>]*href="\/hq\/partners"[^>]*>‹ All partners<\/a>/);
    expect(html).toMatch(/<h1[^>]*>TU Delft Blockchain Lab<\/h1>/);
    expect(html).toMatch(/color:var\(--green\);background:var\(--green-fill\)">Agreed<\/span>/);
    expect(html).toMatch(/<button type="button"[^>]*>Edit<\/button>/);
    expect(html).toMatch(/<button type="button"[^>]*title="Delete"[^>]*>Delete<\/button>/);
    // Viewing, not editing: no name field, no Saved flash, no refusal.
    expect(html).not.toContain('aria-label="Partner name"');
    expect(html).not.toContain(">Saved<");
    expect(html).not.toContain('role="alert"');
  });

  it("lists channel, stage, captain, contact and target, then who touched it last", () => {
    const html = page();
    for (const label of ["Channel", "Stage", "Captain", "Contact", "Target"]) {
      expect(html).toContain(`>${label}</span>`);
    }
    expect(html).toContain(">University</span>");
    expect(html).toContain(">Femke de Jong</span>");
    expect(html).toMatch(/font-family:var\(--mono\);font-size:14px">f\.dejong@tudelft\.nl<\/span>/);
    expect(html).toContain('aria-label="Copy f.dejong@tudelft.nl"');
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain("font-variant-numeric:tabular-nums\">6</span>");
    expect(html).toContain("Last touched by Nienke, Sep 16.");
    expect(html).not.toContain("Changes save as you make them");
  });

  it("shows the checklist, the target bar, the contact log and the attributed teams", () => {
    const html = page();
    for (const title of ["Exchange checklist", "Contact log", "Attributed teams"]) {
      expect(html).toContain(`>${title}</div>`);
    }
    expect(html).toMatch(/<input type="checkbox"[^>]*checked=""\/><span style="color:var\(--label-3\)">Communicated with community members<\/span>/);
    expect(html).toMatch(/<input type="checkbox" style="[^"]*"\/><span style="color:var\(--label-1\)">Event cohosted<\/span>/);
    expect(html).toContain("accent-color:var(--accent);width:15px;height:15px;margin:0");
    expect(html).toContain("Attributed teams vs target");
    expect(html).toContain(">3 / 6</span>");
    expect(html).toContain("width:50%");
    expect(html).toContain('placeholder="Log an interaction"');
    expect(html).toMatch(/<button type="button"[^>]*>Add<\/button>/);
    expect(html).toContain(">Sep 15, 11:20, Nienke</div>");
    expect(html).toContain("Femke confirmed the lab will host office hours every Tuesday.");
    expect(html.indexOf("Sep 15, 11:20")).toBeLessThan(html.indexOf("Sep 2, 09:40"));
    expect(html).toContain(">Windmolen DAO</span>");
    expect(html).toMatch(/color:var\(--orange\);background:var\(--orange-fill\)">Amber<\/span>/);
    expect(html).toMatch(/color:var\(--green\);background:var\(--green-fill\)">Green<\/span>/);
    expect(html).not.toContain("border-bottom");
  });

  it("shows only the title of an empty Attributed teams card, and no forbidden characters", () => {
    const html = page({ ...detail, teams: [], contacts: [], attributed: 0 });
    expect(html).toContain(">Attributed teams</div>");
    expect(html).not.toContain("No projects attributed yet.");
    expect(html).toContain(">0 / 6</span>");
    expect(html).toContain("width:0%");
    expect(html).not.toMatch(FORBIDDEN);
    expect(page()).not.toMatch(FORBIDDEN);
  });
});
