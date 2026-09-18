// The shared entry card the team page's Earlier list and the Captains' Den
// both render, to static markup: the reading state with and without its Edit
// control, the tag slot, and the copy rules the design sets (the caller's
// meta line as given, never "(you)" or an ISO date, no em dash or middot).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, replace() {}, push() {} }) }));
vi.mock("@/lib/hq/actions/reporting", () => ({ editReportingUpdate: vi.fn() }));

import { ReportingEntryCard } from "@/components/hq/reporting-entry-card";
import type { ReportingEntryView } from "@/lib/hq/reporting";

const entry: ReportingEntryView = {
  id: "entry-1", projectId: "project-1", periodId: "week-1", periodSequence: 1,
  body: "Shipped the QR checkout flow on devnet.\nNext week: settlement to EUR.",
  visibility: "shared", source: "hq", version: 1, late: false, edited: false,
  submittedAt: "2026-09-16T10:00:00.000Z", updatedAt: "2026-09-16T10:00:00.000Z",
  authorName: "Nienke Visser", authorIsYou: true, canEdit: true, voided: false,
};
const META = "Week 1. Nienke Visser, 16 September";

const render = (props: Partial<Parameters<typeof ReportingEntryCard>[0]> = {}) =>
  renderToStaticMarkup(createElement(ReportingEntryCard, { entry, meta: META, canEdit: true, onSaved: () => {}, ...props }));

describe("ReportingEntryCard", () => {
  it("renders the body as text and the caller's meta line, with the Edit control for an author", () => {
    const html = render();
    expect(html).toMatch(/^<article/);
    expect(html).toContain("Shipped the QR checkout flow on devnet.\nNext week: settlement to EUR.");
    expect(html).toContain(`<span>${META}</span>`);
    expect(html).toMatch(/<button type="button"[^>]*>Edit<\/button>/);
    // Reading state only: no editor until Edit is pressed.
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("Save");
  });

  it("offers no Edit control when the caller withholds it", () => {
    const html = render({ canEdit: false });
    expect(html).toContain(`<span>${META}</span>`);
    expect(html).not.toContain(">Edit<");
    expect(html).not.toContain("<button");
  });

  it("renders the tag slot after the meta text", () => {
    const html = render({ canEdit: false, tag: createElement("span", { "data-tag": "private" }, "Private") });
    expect(html.indexOf(META)).toBeLessThan(html.indexOf('data-tag="private"'));
    expect(html).toContain(">Private</span>");
  });

  it("says only what the caller's meta says: no (you), no ISO date, no edited or late wording of its own", () => {
    const html = render({ entry: { ...entry, edited: true, late: true, version: 3 } });
    expect(html).not.toContain("(you)");
    expect(html).not.toContain("2026-09-16");
    expect(html).not.toMatch(/edited|late/i);
  });

  it("uses no em dash and no middot, in the markup or the stylesheet", () => {
    expect(render()).not.toMatch(/[—·]/);
    const css = readFileSync(join(process.cwd(), "components/hq/reporting-entry-card.module.css"), "utf8");
    expect(css).not.toMatch(/[—·]/);
    // The design's card: card cream, the line border, 24px 28px padding, no radius.
    expect(css).toContain("background:#fdfbf7");
    expect(css).toContain("border:1px solid rgba(22,19,15,.15)");
    expect(css).toContain("padding:24px 28px");
    expect(css).not.toMatch(/border-radius:(?!0[;\s])/);
  });
});
