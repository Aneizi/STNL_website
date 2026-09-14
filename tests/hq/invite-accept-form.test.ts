// AcceptInvitationForm (app/hq/(member)/invite/continue/accept-form.tsx):
// the client half of the accept step. useActionState is mocked to a fixed
// [result, action, pending] tuple so each render — the initial button, a
// pending submit, and a settled outcome — can be checked without driving a
// real transition through renderToStaticMarkup, which never runs effects or
// event handlers. The action itself (what result an outcome actually
// produces) is exercised for real in tests/hq/invite-accept-action.test.ts.
import { createElement } from "react";
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

const render = () => renderToStaticMarkup(createElement(AcceptInvitationForm));

beforeEach(() => { vi.clearAllMocks(); });

describe("AcceptInvitationForm", () => {
  it("shows the submit control before any result, wired to the real accept action", () => {
    withState(null);
    const html = render();
    expect(html).toContain("Accept and become a Captain");
    expect(html).toMatch(/<form[^>]*>/);
    expect(mocks.useActionState).toHaveBeenCalledWith(expect.any(Function), null);
  });

  it("disables the button and changes its label while pending", () => {
    withState(null, true);
    const html = render();
    expect(html).toContain("Accepting…");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>/);
  });

  it("renders the granted outcome with a status role, success copy and a link to the Captain page", () => {
    withState({ outcome: "granted" });
    const html = render();
    expect(html).toContain('role="status"');
    expect(html).toContain("You&#x27;re a");
    expect(html).toContain("Captain access");
    expect(html).toMatch(/<a[^>]*href="\/hq\/captain"[^>]*>Go to Captain/);
    expect(html).not.toContain("Accept and become a Captain");
  });

  it.each([
    ["already-redeemed", "Already"],
    ["already-captain", "Already a"],
  ] as const)("renders %s as a status, with no link to the Captain page", (outcome, heading) => {
    withState({ outcome });
    const html = render();
    expect(html).toContain('role="status"');
    expect(html).toContain(heading);
    expect(html).not.toContain('href="/hq/captain"');
  });

  it.each([
    ["revoked", "revoked"],
    ["expired", "expired"],
    ["full", "full"],
    ["unverified", "account"],
    ["not-found", "link"],
    ["no-profile", "there"],
    ["invalid-continuation", "link"],
  ] as const)("renders %s as an alert, with no link to the Captain page", (outcome, fragment) => {
    withState({ outcome });
    const html = render();
    expect(html).toContain('role="alert"');
    expect(html.toLowerCase()).toContain(fragment);
    expect(html).not.toContain('href="/hq/captain"');
    expect(html).not.toContain("Accept and become a Captain");
  });
});
