// Phase 3's member-facing acceptance checks that are about what the screen
// says, not about what the database holds: every import failure has its own
// wording, the join screen's own refusals name nothing about the team, and
// the onboarding screens open with the copy and links the design gives them.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { IMPORT_REFUSAL_MESSAGES, JOIN_LINK_MESSAGES, isNetherlands, NETHERLANDS } from "@/lib/hq/builder-types";
import { joinLink, parseJoinCode } from "@/lib/hq/member-routes";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {}, push() {} }) }));
vi.mock("@/lib/hq/member-auth", () => ({ requireMember: vi.fn(), currentMember: vi.fn() }));
vi.mock("@/lib/hq/actions/builders", () => ({
  acceptBuilderInvite: vi.fn(), createBuilderInvite: vi.fn(),
  importBuilderTeam: vi.fn(), previewBuilderImport: vi.fn(), previewBuilderInvite: vi.fn(), refreshBuilderTeam: vi.fn(),
  requestBuilderReview: vi.fn(), saveBuilderTeam: vi.fn(),
}));
// The icon package ships its source; these checks render markup, not glyphs,
// so the icon becomes an <svg> carrying the props it was given.
vi.mock("symbols-react", () => ({
  IconArrowRight: (props: Record<string, unknown>) => createElement("svg", { ...props, "data-icon": "arrow" }),
}));

import { BuilderInitialize, BuilderJoin, BuilderWelcome } from "@/components/hq/builder-onboarding";

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
      // short one on purpose, "say so plainly", and the screen keeps its
      // help modal beneath it rather than padding the sentence.
      expect(message.length, message).toBeGreaterThan(25);
      expect(message.toLowerCase()).not.toMatch(/could not import|something went wrong|try again later\.?$/);
    }
    // The two gate refusals say where the fact lives, so the builder can act.
    expect(IMPORT_REFUSAL_MESSAGES.not_dutch).toContain("Colosseum, not in HQ");
    expect(IMPORT_REFUSAL_MESSAGES.wrong_edition).toContain("different hackathon");
    expect(IMPORT_REFUSAL_MESSAGES.edition_not_configured).toContain("has not confirmed");
    expect(IMPORT_REFUSAL_MESSAGES.already_imported).toBe("This team is already in HQ.");
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

describe("the welcome choices", () => {
  it("links the two ways in and Home, with nothing to submit", () => {
    const html = renderToStaticMarkup(createElement(BuilderWelcome, { hackathonId: 41 }));
    expect(html).toMatch(/<a[^>]*href="\/hq\/initialize\?hackathon=41"[^>]*>/);
    expect(html).toContain("Import your team");
    expect(html).toContain("Use your Colosseum project link.");
    expect(html).toMatch(/<a[^>]*href="\/hq\/join"[^>]*>/);
    expect(html).toContain("Join a team");
    expect(html).toContain("Use the join link a teammate sent you.");
    expect(html).toMatch(/<a[^>]*href="\/hq\/dashboard"[^>]*>I’m not building this time<\/a>/);
    expect(html).not.toMatch(/<form|<select|<button|Your hackathon|no open hackathons/);
    expect(html).toContain('fill="currentColor"');
    expect(html).not.toMatch(/[—·]/);
  });

  it("links Initialize without an edition when none is open", () => {
    const html = renderToStaticMarkup(createElement(BuilderWelcome, { hackathonId: null }));
    expect(html).toMatch(/<a[^>]*href="\/hq\/initialize"[^>]*>/);
    expect(html).not.toContain("?hackathon=");
  });
});

describe("progressive onboarding", () => {
  it("starts with the design's intro, one project field and the help trigger", () => {
    const html = renderToStaticMarkup(createElement(BuilderInitialize, { hackathonId: 41 }));
    expect(html).toContain("Use the Colosseum project registered in the Netherlands for Colosseum Crypto World&#x27;s Fair.");
    expect(html).toContain("Colosseum project link");
    expect(html).toContain("Continue");
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>Can’t find your project\?<\/button>/);
    expect(html).not.toContain("Which teammate are you?");
    expect(html).not.toContain("Import my team");
    expect(html).not.toMatch(/Project imports open|Go to my HQ|t\.me\/|<dialog/);
    expect(html).not.toMatch(/[—·]/);
  });

  it("starts a pasted team link with the design's intro, without naming a recipient", () => {
    const html = renderToStaticMarkup(createElement(BuilderJoin));
    expect(html).toContain("Paste your team’s join link.");
    expect(html).toContain("Team join link");
    expect(html).not.toContain("This link is for");
    expect(html).not.toContain("That’s me");
    expect(html).not.toMatch(/[—·]/);
  });
});
