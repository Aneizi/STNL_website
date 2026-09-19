// Step 2 of the Captain invitation flow: the continuation page
// (app/hq/(member)/invite/continue/page.tsx). Every branch a visitor can
// land on, rendered directly the way tests/hq/member-shell.test.ts renders
// CaptainPage: currentMember() and the continuation store mocked, the
// AcceptInvitationForm client component stubbed out (its own logic is a
// thin pass-through over ../copy.ts, exercised through the action tests and
// the copy table's own exhaustive Record type). The stub renders its
// children, because the page hands the explanation to the form.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ currentMember: vi.fn(), readInviteContinuation: vi.fn(), cookies: vi.fn() }));
vi.mock("@/lib/hq/member-auth", () => ({ currentMember: mocks.currentMember }));
vi.mock("@/lib/hq/builder-db", () => ({ builderDatabase: () => ({}) }));
vi.mock("@/lib/hq/invite-continuation", () => ({ INVITE_CONTINUATION_COOKIE: "hq_invite_continuation", readInviteContinuation: mocks.readInviteContinuation }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));
vi.mock("@/app/hq/(member)/invite/continue/accept-form", () => ({
  AcceptInvitationForm: ({ children }: { children?: ReactNode }) => createElement("div", { "data-testid": "accept-form" }, children),
}));

import InviteContinuePage from "@/app/hq/(member)/invite/continue/page";

const INTRO =
  "Accepting gives your HQ account Captain access, nothing else. It grants no admin access and no project assignment; an admin assigns your team separately, and nothing about your existing teams or roles changes.";
const NOT_FOUND = "This invitation link is not one we recognise. Ask the admin who sent it for a fresh one.";

function withCookie(value: string | undefined) {
  mocks.cookies.mockResolvedValue({ get: (name: string) => (name === "hq_invite_continuation" && value !== undefined ? { value } : undefined) });
}

// Every render is held to the member copy rule: no em dash, no middot.
const render = async () => {
  const html = renderToStaticMarkup(await InviteContinuePage());
  expect(html).not.toMatch(/[—·]/);
  return html;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentMember.mockResolvedValue(null);
  withCookie(undefined);
});

describe("the continuation page", () => {
  it("shows a generic not-found message when there is no continuation cookie at all, and mentions no invitation details", async () => {
    mocks.readInviteContinuation.mockResolvedValue(null);
    const html = await render();
    expect(html).toMatch(/<h1>Invitation <em>not found\.<\/em><\/h1>/);
    expect(html).toMatch(/<p role="alert" class="[^"]*">/);
    expect(html).toContain(`>${NOT_FOUND}</p>`);
    expect(html).not.toContain("data-testid=\"accept-form\"");
    expect(html).not.toContain("Sign in");
    expect(html).not.toContain(INTRO);
  });

  it("shows the same not-found message for a cookie that resolves to nothing, forged, unknown or expired, indistinguishably", async () => {
    withCookie("forged-or-expired");
    mocks.readInviteContinuation.mockResolvedValue(null);
    const html = await render();
    expect(html).toContain("not found");
    expect(html).toContain(NOT_FOUND);
    expect(mocks.readInviteContinuation).toHaveBeenCalledWith(expect.anything(), "forged-or-expired");
  });

  it("shows a signed-out visitor the explanation and a sign-in link that returns here, never the accept control", async () => {
    withCookie("cont-1");
    mocks.readInviteContinuation.mockResolvedValue({ invitationId: "inv-1", expired: false, revoked: false, full: false });
    mocks.currentMember.mockResolvedValue(null);
    const html = await render();
    expect(html).toMatch(/<h1>Become a <em>Captain\.<\/em><\/h1>/);
    expect(html).toContain(`<p>${INTRO}</p>`);
    expect(html).toMatch(/<a[^>]*href="\/hq\/login\?next=%2Fhq%2Finvite%2Fcontinue"[^>]*>Log in or sign up<\/a>/);
    expect(html).not.toContain("data-testid=\"accept-form\"");
  });

  it("shows a signed-in, verified visitor the accept control for an open invitation, with the explanation inside it", async () => {
    withCookie("cont-2");
    mocks.readInviteContinuation.mockResolvedValue({ invitationId: "inv-2", expired: false, revoked: false, full: false });
    mocks.currentMember.mockResolvedValue({ id: "acct-1", email: "acct-1@example.test", name: "Acct" });
    const html = await render();
    expect(html).toMatch(/<h1>Become a <em>Captain\.<\/em><\/h1>/);
    // The explanation belongs to the form so it can leave with the button.
    expect(html).toContain(`<div data-testid="accept-form"><p>${INTRO}</p></div>`);
    expect(html).not.toContain("Log in or sign up");
  });

  it("finishes a new account's name step while preserving the Captain invitation", async () => {
    withCookie("cont-new");
    mocks.readInviteContinuation.mockResolvedValue({ invitationId: "inv-new", expired: false, revoked: false, full: false });
    mocks.currentMember.mockResolvedValue({ id: "acct-new", email: "new@example.test", name: "" });
    await expect(InviteContinuePage()).rejects.toThrow("REDIRECT:/hq/profile?next=%2Fhq%2Finvite%2Fcontinue");
  });

  it.each([
    ["revoked", { revoked: true }, "revoked.", "This invitation was withdrawn by an admin. Nothing on your account has changed."],
    ["expired", { expired: true }, "expired.", "This invitation has passed its expiry. Ask the admin who sent it for a fresh one."],
    ["full", { full: true }, "used up.", "Every seat on this invitation has been taken. Ask the admin who sent it for a fresh one."],
  ])("shows the %s message and no accept control, whether or not the visitor is signed in", async (_label, flags, emphasis, body) => {
    withCookie("cont-3");
    mocks.readInviteContinuation.mockResolvedValue({ invitationId: "inv-3", expired: false, revoked: false, full: false, ...flags });
    for (const member of [null, { id: "acct-1", email: "acct-1@example.test", name: "Acct" }]) {
      mocks.currentMember.mockResolvedValue(member);
      const html = await render();
      expect(html).toContain(`<h1>Invitation <em>${emphasis}</em></h1>`);
      expect(html).toMatch(/<p role="alert" class="[^"]*">/);
      expect(html).toContain(`>${body}</p>`);
      expect(html).not.toContain("data-testid=\"accept-form\"");
      expect(html).not.toContain("Log in or sign up");
      expect(html).not.toContain("Captain access"); // the explanation only appears while the link is still open
    }
  });

  it("gives revoked precedence over expired and full in the snapshot", async () => {
    withCookie("cont-5");
    mocks.readInviteContinuation.mockResolvedValue({ invitationId: "inv-5", expired: true, revoked: true, full: true });
    const html = await render();
    expect(html).toContain("revoked.");
    expect(html).not.toContain("expired.");
    expect(html).not.toContain("used up.");
  });

  it("never renders the invitation id, a continuation id or anything that looks like a bearer token", async () => {
    withCookie("cont-4-secret-id");
    mocks.readInviteContinuation.mockResolvedValue({ invitationId: "11111111-2222-4333-8444-555555555555", expired: false, revoked: false, full: false });
    mocks.currentMember.mockResolvedValue({ id: "acct-1", email: "acct-1@example.test", name: "Acct" });
    const html = await render();
    expect(html).not.toContain("cont-4-secret-id");
    expect(html).not.toContain("11111111-2222-4333-8444-555555555555");
  });
});
