// Step 2 of the Captain invitation flow: the continuation page
// (app/hq/(member)/invite/continue/page.tsx). Every branch a visitor can
// land on, rendered directly the way tests/hq/member-shell.test.ts renders
// CaptainPage — currentMember() and the continuation store mocked, the
// AcceptInvitationForm client component stubbed out (its own logic is a
// thin pass-through over ../copy.ts, exercised through the action tests and
// the copy table's own exhaustive Record type).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ currentMember: vi.fn(), readInviteContinuation: vi.fn(), cookies: vi.fn() }));
vi.mock("@/lib/hq/member-auth", () => ({ currentMember: mocks.currentMember }));
vi.mock("@/lib/hq/builder-db", () => ({ builderDatabase: () => ({}) }));
vi.mock("@/lib/hq/invite-continuation", () => ({ INVITE_CONTINUATION_COOKIE: "hq_invite_continuation", readInviteContinuation: mocks.readInviteContinuation }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/app/hq/(member)/invite/continue/accept-form", () => ({ AcceptInvitationForm: () => createElement("div", { "data-testid": "accept-form" }, "accept-form") }));

import InviteContinuePage from "@/app/hq/(member)/invite/continue/page";

function withCookie(value: string | undefined) {
  mocks.cookies.mockResolvedValue({ get: (name: string) => (name === "hq_invite_continuation" && value !== undefined ? { value } : undefined) });
}

const render = async () => renderToStaticMarkup(await InviteContinuePage());

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentMember.mockResolvedValue(null);
  withCookie(undefined);
});

describe("the continuation page", () => {
  it("shows a generic invalid-link message when there is no continuation cookie at all, and mentions no invitation", async () => {
    mocks.readInviteContinuation.mockResolvedValue(null);
    const html = await render();
    expect(html).toContain("Invalid");
    expect(html).toContain("link");
    expect(html).not.toContain("data-testid=\"accept-form\"");
    expect(html).not.toContain("Sign in");
  });

  it("shows the same invalid-link message for a cookie that resolves to nothing — forged, unknown or expired, indistinguishably", async () => {
    withCookie("forged-or-expired");
    mocks.readInviteContinuation.mockResolvedValue(null);
    const html = await render();
    expect(html).toContain("Invalid");
    expect(mocks.readInviteContinuation).toHaveBeenCalledWith(expect.anything(), "forged-or-expired");
  });

  it("shows a signed-out visitor the explanation and a sign-in link that returns here, never the accept control", async () => {
    withCookie("cont-1");
    mocks.readInviteContinuation.mockResolvedValue({ invitationId: "inv-1", expired: false, revoked: false, full: false });
    mocks.currentMember.mockResolvedValue(null);
    const html = await render();
    expect(html).toContain("Captain access");
    expect(html).toMatch(/<a[^>]*href="\/hq\/signin\?next=%2Fhq%2Finvite%2Fcontinue"[^>]*>Sign in to continue<\/a>/);
    expect(html).not.toContain("data-testid=\"accept-form\"");
  });

  it("shows a signed-in, verified visitor the accept control for an open invitation", async () => {
    withCookie("cont-2");
    mocks.readInviteContinuation.mockResolvedValue({ invitationId: "inv-2", expired: false, revoked: false, full: false });
    mocks.currentMember.mockResolvedValue({ id: "acct-1", email: "acct-1@example.test", name: "Acct" });
    const html = await render();
    expect(html).toContain("Captain access");
    expect(html).toContain("data-testid=\"accept-form\"");
    expect(html).not.toContain("Sign in to continue");
  });

  it.each([
    ["revoked", { revoked: true }, "revoked"],
    ["expired", { expired: true }, "expired"],
    ["full", { full: true }, "full"],
  ])("shows the %s message and no accept control, whether or not the visitor is signed in", async (_label, flags, expected) => {
    withCookie("cont-3");
    mocks.readInviteContinuation.mockResolvedValue({ invitationId: "inv-3", expired: false, revoked: false, full: false, ...flags });
    for (const member of [null, { id: "acct-1", email: "acct-1@example.test", name: "Acct" }]) {
      mocks.currentMember.mockResolvedValue(member);
      const html = await render();
      expect(html.toLowerCase()).toContain(expected);
      expect(html).not.toContain("data-testid=\"accept-form\"");
      expect(html).not.toContain("Sign in to continue");
      expect(html).not.toContain("Captain access"); // the explanation only appears while the link is still open
    }
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
