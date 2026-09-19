// AcceptInvitationForm (app/hq/(member)/invite/continue/accept-form.tsx):
// the client half of the accept step. useActionState is mocked to a fixed
// [result, action, pending] tuple so each render (the initial button, a
// pending submit, and a settled outcome) can be checked without driving a
// real transition through renderToStaticMarkup, which never runs effects or
// event handlers. The action itself (what result an outcome actually
// produces) is exercised for real in tests/hq/invite-accept-action.test.ts.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcceptCaptainInvitationActionResult } from "@/lib/hq/actions/invite";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ useActionState: vi.fn(), refresh: vi.fn() }));
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), useActionState: mocks.useActionState }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/hq/actions/invite", () => ({ acceptCaptainInvitationFromContinuation: vi.fn() }));
vi.mock("symbols-react", () => ({ IconArrowRight: (props: Record<string, unknown>) => createElement("svg", props) }));

import { AcceptInvitationForm } from "@/app/hq/(member)/invite/continue/accept-form";

function withState(result: AcceptCaptainInvitationActionResult | null, pending = false) {
  mocks.useActionState.mockReturnValue([result, vi.fn(), pending]);
}

// The page's explanation, passed in the way the page passes it: as children.
const intro = () => createElement("p", null, "intro-copy");

// Every render is held to the member copy rule: no em dash, no middot.
const render = (children?: ReactNode) => {
  const html = renderToStaticMarkup(createElement(AcceptInvitationForm, null, children));
  expect(html).not.toMatch(/[—·]/);
  return html;
};

beforeEach(() => { vi.clearAllMocks(); });

describe("AcceptInvitationForm", () => {
  it("shows the submit control before any result, wired to the real accept action", () => {
    withState(null);
    const html = render();
    expect(html).toContain("Accept and become a Captain");
    expect(html).toMatch(/<form[^>]*>/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Accept and become a Captain<svg[^>]*width="18"[^>]*height="18"[^>]*fill="currentColor"[^>]*aria-hidden="true"[^>]*><\/svg><\/button>/);
    expect(mocks.useActionState).toHaveBeenCalledWith(expect.any(Function), null);
  });

  it("renders its children ahead of the form while there is no result", () => {
    withState(null);
    const html = render(intro());
    expect(html).toMatch(/^<p>intro-copy<\/p><form/);
  });

  it("disables the button and changes its label while pending", () => {
    withState(null, true);
    const html = render(intro());
    expect(html).toContain("Accepting…");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>/);
    expect(html).not.toContain("Accept and become a Captain");
    expect(html).toContain("intro-copy"); // still open: the explanation stays until a result replaces the form
  });

  it("renders the granted outcome with a status role, the design copy, a fallback link to the menu and no explanation", () => {
    withState({ outcome: "granted" });
    const html = render(intro());
    expect(html).toContain('role="status"');
    expect(html).toMatch(/<h2>You are now a <em>Captain\.<\/em><\/h2>/);
    expect(html).toContain(">Captain access is on your account. An admin will assign your team; until then the Captain page shows no assignments.</p>");
    expect(html).toMatch(/<a[^>]*href="\/hq\/dashboard"[^>]*>Go to menu<svg[^>]*width="18"[^>]*height="18"[^>]*fill="currentColor"[^>]*aria-hidden="true"[^>]*><\/svg><\/a>/);
    expect(html).not.toContain("Accept and become a Captain");
    expect(html).not.toContain("intro-copy");
  });

  it.each([
    ["already-redeemed", "Already"],
    ["already-captain", "Already a"],
  ] as const)("renders %s with a fallback menu link and no explanation", (outcome, heading) => {
    withState({ outcome });
    const html = render(intro());
    expect(html).toContain('role="status"');
    expect(html).toContain(heading);
    expect(html).toContain('href="/hq/dashboard"');
    expect(html).not.toContain("intro-copy");
  });

  it.each([
    ["revoked", "revoked.", "This invitation was withdrawn by an admin. Nothing on your account has changed."],
    ["expired", "expired.", "This invitation has passed its expiry. Ask the admin who sent it for a fresh one."],
    ["full", "used up.", "Every seat on this invitation has been taken. Ask the admin who sent it for a fresh one."],
    ["unverified", "account.", "Add a verified email or connect Telegram to your HQ account, then use this link again."],
    ["not-found", "not found.", "This invitation link is not one we recognise. Ask the admin who sent it for a fresh one."],
    ["no-profile", "there.", "Your account is still finishing setup. Try this link again in a moment."],
    ["invalid-continuation", "not found.", "This invitation link is not one we recognise. Ask the admin who sent it for a fresh one."],
  ] as const)("renders %s as an alert, with no link to the Captain page and no explanation", (outcome, emphasis, body) => {
    withState({ outcome });
    const html = render(intro());
    expect(html).toContain('role="alert"');
    expect(html).toContain(`<em>${emphasis}</em></h2>`);
    expect(html).toContain(`>${body}</p>`);
    expect(html).not.toContain('href="/hq/captain"');
    expect(html).not.toContain("Accept and become a Captain");
    expect(html).not.toContain("intro-copy");
  });
});
