// The operator People table, rendered to static markup: the header and its
// count, the New person control, the role chips, the four columns, a closed
// row (tags, one contact, the chevron, the keyboard role) and the expanded
// editor with its three fields, the Account block, the Captain control in
// each of its states and the Delete control. Also the copy rules: nothing
// of the old Organization and Partner columns, no locked-tag hint, and none
// of the characters the design forbids.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Person, Role } from "@/lib/hq/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, replace() {}, push() {} }) }));
vi.mock("@/components/hq/toast", () => ({ showToast: vi.fn() }));
// The actions carry the database imports; static markup needs their names, not their effects.
vi.mock("@/lib/hq/actions/people", () => ({
  correctPersonMatch: vi.fn(), createPerson: vi.fn(), deletePerson: vi.fn(), setPersonCaptain: vi.fn(), updatePerson: vi.fn(),
}));

import { People, PersonRow } from "@/components/hq/people";

const roles: Role[] = [
  { id: "r1", label: "Partner contact", filterLabel: "Partner contacts", color: "accent", bg: "accent-fill", isJudge: false },
  { id: "r2", label: "Judge", filterLabel: "Judges", color: "indigo", bg: "fill-3", isJudge: true },
  { id: "r5", label: "Other", filterLabel: "Other", color: "label-2", bg: "fill-4", isJudge: false },
];
const removal = { cardId: "", name: "", hackathonId: 6, personId: null, hasAccount: false, rosterRows: 0, otherEditionCards: 0, judgeScores: 0, enrollments: 0 };
/** A linked Captain who signs in with Telegram and also has a login email. */
const joost: Person = {
  id: "p1", name: "Joost Vermeer", roleId: "r2", contact: "@joostv", notes: "Final jury, DeFi track",
  builderUserId: "acct-joost", personId: "person-joost",
  account: { email: "joost@solana.org", telegramUsername: "joostv" }, captain: true,
  tags: [{ kind: "role", label: "Judge", protected: false }, { kind: "capability", label: "Captain", protected: true }],
  removal: { ...removal, hasAccount: true },
};
/** A hand-entered card: a handle, no account. */
const rutger: Person = {
  id: "p2", name: "Rutger Bos", roleId: "r1", contact: "@rutgerb", notes: "", builderUserId: null, personId: null,
  account: null, captain: false, tags: [{ kind: "role", label: "Partner contact", protected: false }], removal,
};
/** A linked account that signs in with email only and holds no grant. */
const femke: Person = {
  ...joost, id: "p3", name: "Femke de Jong", contact: "f.dejong@tudelft.nl", notes: "",
  builderUserId: "acct-femke", personId: "person-femke",
  account: { email: "f.dejong@tudelft.nl", telegramUsername: null }, captain: false,
  tags: [{ kind: "role", label: "Judge", protected: false }],
};

const FORBIDDEN = /[—·]/;
const page = (people: Person[]) => renderToStaticMarkup(createElement(People, { people, roles, reset: false }));
const row = (person: Person, expanded: boolean) =>
  renderToStaticMarkup(createElement(PersonRow, { person, roles, expanded, matchCleared: false, onToggle() {}, onEdit() {}, onMatchCleared() {}, onDeleted() {} }));
/** The whole <button> element carrying `label`, so its own attributes can be asserted; fails loudly when absent. */
function button(html: string, label: string): string {
  const match = html.match(new RegExp(`<button(?:(?!<\\/button>).)*${label}(?:(?!<\\/button>).)*<\\/button>`, "s"));
  if (!match) throw new Error(`no button labelled ${label}`);
  return match[0];
}

describe("People", () => {
  it("renders the title with the unfiltered count, the New person control, the role chips and the four columns", () => {
    const html = page([joost, rutger, femke]);
    expect(html).toMatch(/<h1[^>]*>People <span[^>]*>3<\/span><\/h1>/);
    expect(button(html, "New person")).toContain('type="button"');
    // "All" is selected on arrival; the other chips carry the roles' filter labels, in seed order.
    expect(button(html, "All")).toContain('aria-pressed="true"');
    expect(button(html, "All")).toContain("var(--accent-fill)");
    expect(button(html, "Partner contacts")).toContain('aria-pressed="false"');
    expect(button(html, "Partner contacts")).toContain("var(--fill-3)");
    expect(html.indexOf("Partner contacts")).toBeLessThan(html.indexOf("Judges"));
    expect(html).toContain("<span>Name</span><span>Tags</span><span>Contact</span><span></span>");
    // The New person card is closed until asked for, so its fields are absent.
    expect(html).not.toContain("@handle");
    expect(html).not.toContain("Other (specify in Notes)");
    // Nothing of the old table: no Organization or Partner column, no partner filter, no Edit link, no locked tag.
    expect(html).not.toMatch(/Organization|All partners|Linked partner|Granted in Admin|>Edit</);
    expect(html).not.toMatch(FORBIDDEN);
  });

  it("closes every row on arrival, each a keyboard-reachable button with its tags, one contact and the chevron", () => {
    const html = page([joost, rutger]);
    expect(html.match(/role="button"/g)).toHaveLength(2);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
    expect(html).not.toContain('aria-expanded="true"');
    expect(html.match(/tabindex="0"/g)).toHaveLength(2);
    expect(html).toContain("Joost Vermeer");
    expect(html).toContain(">Judge</span>");
    expect(html).toContain(">Captain</span>");
    expect(html).toContain("@joostv");
    expect(html).toContain("@rutgerb");
    // The Captain tag is in the accent colours; the role tag in the role's own.
    expect(html).toMatch(/color:var\(--accent-deep\);background:var\(--accent-fill\)">Captain</);
    expect(html).toMatch(/color:var\(--indigo\);background:var\(--fill-3\)">Judge</);
    expect(html.match(/aria-hidden="true"[^>]*>▼</g)).toHaveLength(2);
    expect(html).toContain("rotate(0deg)");
    // Nothing from the editor leaks into a closed row.
    expect(html).not.toMatch(/Logs in with|Wrong match|Make Captain|Remove Captain|Delete person|placeholder="None"/);
    expect(html).not.toContain("Notes");
    expect(html).not.toMatch(FORBIDDEN);
  });

  it("expands a linked Captain into the editor, the Account block and the Remove Captain control", () => {
    const html = row(joost, true);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("rotate(180deg)");
    expect(html).toContain("hq-fade-in");
    for (const caption of ["Name", "Role", "Notes", "Account", "Captain"]) expect(html).toContain(`>${caption}</span>`);
    expect(html).toContain('value="Joost Vermeer"');
    expect(html).toContain('value="Final jury, DeFi track"');
    expect(html).toContain('placeholder="None"');
    // The editor's role list reads plain "Other"; the create form's suffix belongs there alone.
    expect(html).toContain(">Other</option>");
    expect(html).not.toContain("Other (specify in Notes)");
    expect(html).toContain("Logs in with Telegram @joostv");
    expect(html).toContain("Also joost@solana.org");
    expect(button(html, "Wrong match?")).toContain("hq-hover-accent");
    expect(button(html, "Remove Captain")).toContain("inset 0 0 0 1px var(--label-1)");
    expect(button(html, "Remove Captain")).not.toContain("disabled");
    expect(html).toContain("Can be assigned to projects.");
    expect(html).not.toContain("Make Captain");
    expect(button(html, "Delete person")).toContain("var(--red)");
    expect(html).not.toMatch(FORBIDDEN);
  });

  it("offers Make Captain to a linked account without a grant, and says which login it uses", () => {
    const html = row(femke, true);
    expect(html).toContain("Logs in with f.dejong@tudelft.nl");
    expect(html).not.toContain("Also ");
    expect(button(html, "Make Captain")).toContain("background:var(--label-1)");
    expect(button(html, "Make Captain")).not.toContain("disabled");
    expect(html).toContain("Grants project access once assigned.");
    expect(html).toContain("Wrong match?");
    expect(html).not.toMatch(FORBIDDEN);
  });

  it("keeps the Captain control disabled at half opacity on a hand-entered card, and never offers a match correction there", () => {
    const html = row(rutger, true);
    expect(html).toContain("@rutgerb. No HQ account yet.");
    expect(button(html, "Make Captain")).toContain('disabled=""');
    expect(button(html, "Make Captain")).toContain("opacity:0.5");
    expect(button(html, "Make Captain")).toContain("cursor:pointer");
    expect(html.match(/No HQ account yet\./g)).toHaveLength(2);
    expect(html).not.toContain("Wrong match?");
    expect(html).not.toContain("Also ");
    expect(html).toContain("Delete person");
    expect(html).not.toMatch(FORBIDDEN);
  });

  it("names the undrawn account states tersely", () => {
    expect(row({ ...rutger, contact: "" }, true)).toContain("No contact, no HQ account.");
    expect(row({ ...femke, account: { email: null, telegramUsername: null }, contact: "" }, true)).toContain("Linked account");
    expect(row({ ...femke, account: { email: null, telegramUsername: "femke_tg" }, contact: "@femke_tg" }, true)).toContain("Logs in with Telegram @femke_tg");
  });
});
