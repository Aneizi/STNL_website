// The Demo day screen, rendered to static markup: the three cards' copy on
// the operator type scale, the finalist count colour rule, the picker's
// eligibility and "(verified)" suffix, the results table sorted by average
// (and its empty state), the score modal's copy and controls, the rule
// lines the design dropped, and none of the characters it forbids.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Award, DemoProject, FinalistProject, Judge, Score } from "@/lib/hq/types";

// The screen's server actions carry the database imports; static markup
// needs their names, not their effects.
vi.mock("@/lib/hq/actions/demo", () => ({
  addAward: vi.fn(),
  addFinalist: vi.fn(),
  addScore: vi.fn(),
  clearScores: vi.fn(),
  removeAward: vi.fn(),
  removeFinalist: vi.fn(),
  setAwardWinner: vi.fn(),
}));

import { DemoDay, ScoreModal } from "@/components/hq/demo-day";

const FORBIDDEN = /[—–·]/;
const GATES = 5;

const projects: DemoProject[] = [
  { id: "p1", name: "Grachtenpay", partnerName: "Rabobank Innovation", eventSrc: "Kickoff Amsterdam", gatesDone: 5 },
  { id: "p2", name: "Windmolen DAO", partnerName: "TU Delft Blockchain Lab", eventSrc: "Kickoff Amsterdam", gatesDone: 3 },
  { id: "p3", name: "Tulipswap", partnerName: "Solana Foundation EU", eventSrc: "Kickoff Amsterdam", gatesDone: 5 },
  { id: "p6", name: "Polderproof", partnerName: "", eventSrc: "Utrecht Student Hack", gatesDone: 5 },
  { id: "p7", name: "Stroopwafel Labs", partnerName: "", eventSrc: "Kickoff Amsterdam", gatesDone: 4 },
];
const finalist = (p: DemoProject, position: number): FinalistProject => ({
  projectId: p.id,
  position,
  name: p.name,
  source: [p.partnerName, p.eventSrc].filter(Boolean).join(", "),
  gatesDone: p.gatesDone,
  gatesTotal: GATES,
});
const finalists = [finalist(projects[0], 1), finalist(projects[2], 2), finalist(projects[4], 3)];
const awards: Award[] = [
  { id: "a1", name: "Grand prize", sponsor: "Superteam NL", amount: 10000, winnerProjectId: null },
  { id: "a4", name: "Community favourite", sponsor: "", amount: 1000, winnerProjectId: "p3" },
];
const scores: Score[] = [
  { id: "s1", judgeId: "j1", projectId: "p1", score: 8, note: "" },
  { id: "s2", judgeId: "j2", projectId: "p1", score: 9, note: "" },
  { id: "s3", judgeId: "j1", projectId: "p3", score: 7, note: "" },
];
const judges: Judge[] = [
  { id: "j1", name: "Joost Vermeer" },
  { id: "j2", name: "Anouk Willems" },
];

type Props = Parameters<typeof DemoDay>[0];
const render = (props: Partial<Props> = {}) =>
  renderToStaticMarkup(
    createElement(DemoDay, {
      projects,
      finalists,
      awards,
      scores,
      judges,
      gatesTotal: GATES,
      finalistCap: 8,
      verifiedOnlyFinalists: false,
      ...props,
    }),
  );

type ModalProps = Parameters<typeof ScoreModal>[0];
const noop = () => {};
const modal = (props: Partial<ModalProps> = {}) =>
  renderToStaticMarkup(
    createElement(ScoreModal, {
      judges,
      finalists: finalists.map((f) => ({ id: f.projectId, name: f.name })),
      judgeSel: "",
      projectSel: "",
      error: null,
      onPickJudge: noop,
      onPickFinalist: noop,
      onSubmit: noop,
      onClose: noop,
      ...props,
    }),
  );

/** The <option> labels of the first <select> whose markup contains `marker`. */
function options(html: string, marker: string): string[] {
  const select = html.match(new RegExp(`<select(?:(?!<\\/select>).)*${marker}(?:(?!<\\/select>).)*<\\/select>`, "s"));
  if (!select) throw new Error(`no select containing ${marker}`);
  return [...select[0].matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]);
}

describe("the Demo day page", () => {
  it("frames the screen with the Projects back link and the serif title", () => {
    const html = render();
    expect(html).toMatch(/<a[^>]*href="\/hq\/projects"[^>]*>‹ Projects<\/a>/);
    expect(html).toMatch(/<h1[^>]*font-size:44px[^>]*>Demo day<\/h1>/);
    expect(html).not.toMatch(FORBIDDEN);
  });

  it("lists the finalists with their source, gate status and a two-step Remove", () => {
    const html = render();
    expect(html).toContain("Finalists");
    expect(html).toContain("Rabobank Innovation, Kickoff Amsterdam");
    expect(html).toMatch(/color:var\(--green\)[^>]*>Verified</);
    expect(html).toMatch(/color:var\(--orange\)[^>]*>4\/5 gates</);
    expect(html).toMatch(/<button[^>]*title="Delete"[^>]*>Remove<\/button>/);
    // Rows separate by spacing now; the sep-coloured rule lines are gone.
    expect(html).not.toContain("border-bottom:1px solid var(--sep)");
  });

  it("colours the count green while there are finalists within the cap, otherwise muted", () => {
    expect(render()).toMatch(/color:var\(--green\)[^>]*>3 of 8</);
    expect(render({ finalists: [] })).toMatch(/color:var\(--label-3\)[^>]*>0 of 8</);
  });

  it("offers only non-finalists to add, marking verified ones, and only verified ones when the setting says so", () => {
    expect(options(render(), "Pick a project to add")).toEqual([
      "Pick a project to add",
      "Windmolen DAO",
      "Polderproof (verified)",
    ]);
    expect(options(render({ verifiedOnlyFinalists: true }), "Pick a project to add")).toEqual([
      "Pick a project to add",
      "Polderproof (verified)",
    ]);
  });

  it("lists the awards with sponsor and amount, a winner select over the finalists, and the total", () => {
    const html = render();
    expect(html).toContain("Awards");
    expect(html).toContain("2 categories");
    expect(html).toContain('placeholder="New award"');
    expect(html).toContain('placeholder="$"');
    expect(html).toContain("Superteam NL, $10,000");
    expect(options(html, "Undecided")).toEqual(["Undecided", "Grachtenpay", "Tulipswap", "Stroopwafel Labs"]);
    expect(html).toMatch(/<button[^>]*title="Delete"[^>]*>×<\/button>/);
    expect(html).toContain("Total");
    expect(html).toContain("$11,000");
  });

  it("ranks the results by average with the score count, on the wider tracks", () => {
    const html = render();
    expect(html).toContain("Results");
    expect(html).toContain("Enter scores");
    for (const head of ["#", "Project", "Scores", "Average"]) expect(html).toContain(`<span>${head}</span>`);
    expect(html).toContain("grid-template-columns:26px 1fr 96px 96px 62px");
    expect(html).toMatch(/>1<\/span><span[^>]*>Grachtenpay<\/span><span[^>]*>2x<\/span><span[^>]*>8\.5<\/span>/);
    expect(html).toMatch(/>2<\/span><span[^>]*>Tulipswap<\/span><span[^>]*>1x<\/span><span[^>]*>7\.0<\/span>/);
    expect(html).not.toContain("No scores entered yet.");
  });

  it("says so when nothing has been scored, and shows no column header", () => {
    const html = render({ scores: [] });
    expect(html).toContain("No scores entered yet.");
    expect(html).not.toContain("<span>Average</span>");
  });

  it("keeps the score modal closed until asked, with every button a plain button", () => {
    const html = render();
    expect(html).not.toContain("Enter judge scores");
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>Enter scores<\/button>/);
    expect(html.match(/<button/g)?.length).toBe(html.match(/<button type="button"/g)?.length);
  });
});

describe("the score modal", () => {
  it("carries the design copy, both pickers closed, and the score and note inputs", () => {
    const html = modal();
    expect(html).toMatch(/<div[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="demo-score-title"/);
    expect(html).toMatch(/id="demo-score-title"[^>]*>Enter judge scores</);
    expect(html).toContain("2 minute pitch plus Q&amp;A, one score from 1 to 10");
    expect(html).toMatch(/Judge<button[^>]*aria-expanded="false"[^>]*><span>Select a judge<\/span>/);
    expect(html).toMatch(/Finalist<button[^>]*aria-expanded="false"[^>]*><span>Select a finalist<\/span>/);
    expect(html).toMatch(/<input type="number" min="1" max="10" placeholder="Score"/);
    expect(html).toMatch(/<input placeholder="Note"[^>]*maxLength="500"/);
    expect(html).toMatch(/<button type="button"[^>]*>Cancel<\/button>/);
    expect(html).toMatch(/<button type="button"[^>]*>Save score<\/button>/);
    expect(html).not.toContain("Joost Vermeer");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toMatch(FORBIDDEN);
  });

  it("names the chosen judge and finalist in ink, and shows a refusal as an alert", () => {
    const html = modal({ judgeSel: "j2", projectSel: "p3", error: "Score must be between 1 and 10." });
    expect(html).toMatch(/color:var\(--label-1\)[^>]*><span>Anouk Willems<\/span>/);
    expect(html).toMatch(/color:var\(--label-1\)[^>]*><span>Tulipswap<\/span>/);
    expect(html).toMatch(/<div role="alert"[^>]*>Score must be between 1 and 10\.<\/div>/);
  });
});
