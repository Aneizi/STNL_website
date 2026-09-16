// Phase 3's member-facing acceptance checks that are about what the screen
// says, not about what the database holds: the already-imported outcome
// routes to the Telegram group as a logo control with an accessible name and
// names nobody, every import failure has its own wording, and the join
// screen's own refusals name nothing about the team.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { IMPORT_REFUSAL_MESSAGES, JOIN_LINK_MESSAGES, isNetherlands, NETHERLANDS } from "@/lib/hq/builder-types";
import { SUPERTEAM_NL_TELEGRAM_GROUP, SUPERTEAM_NL_TELEGRAM_GROUP_LABEL } from "@/lib/hq/community";
import { joinLink, parseJoinCode } from "@/lib/hq/member-routes";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {}, push() {} }) }));
vi.mock("@/lib/hq/member-auth", () => ({ requireMember: vi.fn(), currentMember: vi.fn() }));
vi.mock("@/lib/hq/actions/builders", () => ({
  acceptBuilderInvite: vi.fn(), chooseBuilderPath: vi.fn(), createBuilderInvite: vi.fn(),
  importBuilderTeam: vi.fn(), previewBuilderImport: vi.fn(), previewBuilderInvite: vi.fn(), refreshBuilderTeam: vi.fn(),
  requestBuilderEvent: vi.fn(), requestBuilderReview: vi.fn(), saveBuilderTeam: vi.fn(),
}));
// The icon package ships its source; these checks render markup, not glyphs,
// so each icon becomes an <svg> carrying the props it was given.
vi.mock("symbols-react", () => ({
  IconArrowRight: (props: Record<string, unknown>) => createElement("svg", { ...props, "data-icon": "arrow" }),
  IconTelegramLogo: (props: Record<string, unknown>) => createElement("svg", { ...props, "data-icon": "telegram" }),
}));

import { BuilderInitialize, BuilderJoin } from "@/components/hq/builder-onboarding";

const ROOT = process.cwd();
const EDITION = {
  id: 41, name: "Spring builders", startDate: "2098-04-01", endDate: "2098-05-01",
  externalId: 6, externalSlug: "frontier", projectsOpen: true, projectsAvailableAt: null,
  signupUrl: "https://colosseum.com/signup", hostingEnabled: false,
};

describe("the country gate", () => {
  it("compares against the plan's own string, tolerating case and whitespace, and never a hard-coded id", () => {
    expect(NETHERLANDS).toBe("Netherlands");
    for (const value of ["Netherlands", "  netherlands ", "NETHERLANDS"]) expect(isNetherlands(value), value).toBe(true);
    for (const value of ["Belgium", "Netherlands Antilles", "", null, undefined]) expect(isNetherlands(value), String(value)).toBe(false);
  });
});

describe("every import failure has its own wording", () => {
  it("gives each refusal a distinct, actionable message, and none of them is a generic 'could not import'", () => {
    const messages = Object.values(IMPORT_REFUSAL_MESSAGES);
    expect(new Set(messages).size).toBe(messages.length);
    for (const message of messages) {
      // Long enough to say something actionable. `already_imported` is the
      // short one on purpose — "say so plainly" — and the screen adds the
      // route to help beneath it rather than padding the sentence.
      expect(message.length, message).toBeGreaterThan(25);
      expect(message.toLowerCase()).not.toMatch(/could not import|something went wrong|try again later\.?$/);
    }
    // The two gate refusals say where the fact lives, so the builder can act.
    expect(IMPORT_REFUSAL_MESSAGES.not_dutch).toContain("Colosseum, not in HQ");
    expect(IMPORT_REFUSAL_MESSAGES.wrong_edition).toContain("different hackathon");
    expect(IMPORT_REFUSAL_MESSAGES.edition_not_configured).toContain("has not confirmed");
  });

  it("keeps the transport failures apart from 'not found', each inviting a retry", async () => {
    const { ColosseumApiError } = await import("@/lib/colosseum-api");
    const { importFailureFor, inviteRetry } = await import("@/lib/hq/project-import");
    const seen = new Map<string, string>();
    for (const code of ["INVALID_URL", "NOT_FOUND", "RATE_LIMITED", "TIMED_OUT", "UNREACHABLE", "INVALID_RESPONSE", "SOURCE_REJECTED", "UNAVAILABLE"] as const) {
      const { reason, message } = importFailureFor(new ColosseumApiError(code));
      expect(seen.has(message), `${code} repeats a message`).toBe(false);
      seen.set(message, reason);
      const retryable = !["INVALID_URL", "NOT_FOUND"].includes(code);
      expect(inviteRetry(reason), code).toBe(retryable);
      if (retryable) expect(message.toLowerCase(), code).toMatch(/try again|wait a minute/);
      // A 404 must never be implied by a transport failure.
      if (retryable) expect(message.toLowerCase(), code).not.toMatch(/no project|does not exist/);
    }
    expect(seen.size).toBe(8);
  });

  it("never renders Colosseum's own error text to the browser", async () => {
    const { ColosseumApiError } = await import("@/lib/colosseum-api");
    const { importFailureFor } = await import("@/lib/hq/project-import");
    const error = new ColosseumApiError("SOURCE_REJECTED", "BAD_REQUEST", "Project directory is not enabled for hackathons: 7");
    expect(importFailureFor(error).message).not.toContain("directory");
    expect(importFailureFor(error).message).not.toContain("7");
  });
});

describe("the already-imported outcome", () => {
  it("renders the Telegram group as a logo control with an accessible name, never a raw URL, and names nobody", () => {
    const html = renderToStaticMarkup(createElement(BuilderInitialize, { hackathon: EDITION, available: true }));
    // Nothing about the group is on screen before a failure says so.
    expect(html).not.toContain(SUPERTEAM_NL_TELEGRAM_GROUP);

    const source = readFileSync(join(ROOT, "components/hq/builder-onboarding.tsx"), "utf8");
    const control = source.slice(source.indexOf("function TelegramGroupControl"), source.indexOf("export function BuilderWelcome"));
    // The icon, with the repository's fill convention, and an accessible name.
    expect(control).toContain("IconTelegramLogo");
    expect(control).toContain("fill='currentColor'");
    expect(control).toContain("aria-label={SUPERTEAM_NL_TELEGRAM_GROUP_LABEL}");
    // The raw invite string is never the link text.
    expect(control).not.toMatch(/>\s*\{SUPERTEAM_NL_TELEGRAM_GROUP\}/);
    expect(control).not.toContain("t.me/");
    expect(SUPERTEAM_NL_TELEGRAM_GROUP).toBe("https://t.me/+XDJmVCvfB-oyMDA8");
    expect(SUPERTEAM_NL_TELEGRAM_GROUP_LABEL).toMatch(/Superteam NL Telegram group/);

    // The already-imported branch offers help, not a retry, and says nothing
    // about who holds the team.
    const branch = source.slice(source.indexOf("failure.reason==='already_imported'"), source.indexOf("<BuilderImportHelp"));
    expect(branch).toContain("<TelegramGroupControl/>");
    expect(branch.toLowerCase()).not.toMatch(/owner|imported by|belongs to [a-z]/);
    expect(IMPORT_REFUSAL_MESSAGES.already_imported).toBe("This team is already in HQ.");
  });
});

describe("the join link", () => {
  it("is a path assembled in one place, and reads back from a whole pasted link or a bare code", () => {
    const code = "917F94-8CE496-4D2C7A-4C70F1";
    expect(joinLink(code)).toBe(`/hq/join/${code}`);
    for (const pasted of [
      code,
      `  ${code}\n`,
      `https://hq.example.test${joinLink(code)}`,
      `https://hq.example.test${joinLink(code)}/`,
      `https://hq.example.test${joinLink(code)}?utm_source=telegram`,
      `https://hq.example.test${joinLink(code)}#x`,
      `917F94 8CE496 4D2C7A 4C70F1`,
    ]) {
      // The store normalises case and separators when it hashes, so what
      // matters here is that the same 24 hex characters come back out of
      // every one of these shapes.
      expect(parseJoinCode(pasted)?.replace(/-/g, ""), pasted).toBe(code.replace(/-/g, ""));
    }
    for (const rubbish of ["", "   ", "https://hq.example.test/hq/join/", "https://example.com/", "not a code", "a".repeat(4000)]) {
      expect(parseJoinCode(rubbish), rubbish).toBeNull();
    }
  });

  it("refuses with four distinct messages, none of which names a team", () => {
    const messages = Object.values(JOIN_LINK_MESSAGES);
    expect(new Set(messages).size).toBe(4);
    for (const message of messages) {
      expect(message.toLowerCase()).not.toMatch(/team is called|project|owner|imported by/);
      expect(message.length).toBeGreaterThan(20);
    }
    expect(JOIN_LINK_MESSAGES.expired).toContain("expired");
    expect(JOIN_LINK_MESSAGES.used).toContain("already been used");
    expect(JOIN_LINK_MESSAGES.other_edition).toContain("no longer running");
  });
});


describe("progressive onboarding", () => {
  it("starts with one project field and keeps import help available", () => {
    const html = renderToStaticMarkup(createElement(BuilderInitialize, { hackathon: EDITION, available: true }));
    expect(html).toContain('Colosseum project link');
    expect(html).toContain('Continue');
    expect(html).toContain('Can’t import your project?');
    expect(html).not.toContain('Which teammate are you?');
    expect(html).not.toContain('Import my team');
  });

  it("starts a pasted team link without naming a recipient", () => {
    const html = renderToStaticMarkup(createElement(BuilderJoin));
    expect(html).toContain('Team join link');
    expect(html).not.toContain('This link is for');
    expect(html).not.toContain('That’s me');
  });
});
