import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ currentUser: vi.fn(), currentMember: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));
vi.mock("@/lib/hq/auth", () => ({ currentUser: mocks.currentUser }));
vi.mock("@/lib/hq/member-auth", () => ({ currentMember: mocks.currentMember }));
vi.mock("@/components/hq/login-form", () => ({ LoginForm: () => createElement("p", null, "Admin form") }));
vi.mock("@/app/hq/(member)/account-form", () => ({ AccountForm: ({ next, error }: { next: string; error?: string }) => createElement("p", { "data-next": next }, error ?? "Member form") }));

import MemberLoginPage from "@/app/hq/(member)/login/page";
import AdminLoginPage from "@/app/hq/admin/login/page";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser.mockResolvedValue(null);
  mocks.currentMember.mockResolvedValue(null);
});

describe("the separate HQ login pages", () => {
  it("keeps member login available when only an operator is signed in", async () => {
    mocks.currentUser.mockResolvedValue({ id: "operator" });
    const html = renderToStaticMarkup(await MemberLoginPage({ searchParams: Promise.resolve({ next: "/hq/join?code=team", error: "telegram" }) }));
    expect(html).toContain('data-next="/hq/join?code=team"');
    expect(html).toContain("telegram");
    expect(mocks.currentUser).not.toHaveBeenCalled();
  });

  it("returns an already signed-in member to their requested member page", async () => {
    mocks.currentMember.mockResolvedValue({ id: "member" });
    await expect(MemberLoginPage({ searchParams: Promise.resolve({ next: "/hq/dashboard" }) })).rejects.toThrow("REDIRECT:/hq/dashboard");
  });

  it.each(["/hq/login", "/hq/signin", "/hq/admin/login", "https://example.com"])("does not redirect a signed-in member back to %s", async (next) => {
    mocks.currentMember.mockResolvedValue({ id: "member" });
    await expect(MemberLoginPage({ searchParams: Promise.resolve({ next }) })).rejects.toThrow("REDIRECT:/hq/welcome");
  });

  it("keeps admin login available when only a member is signed in", async () => {
    mocks.currentMember.mockResolvedValue({ id: "member" });
    expect(renderToStaticMarkup(await AdminLoginPage())).toContain("Admin form");
    expect(mocks.currentMember).not.toHaveBeenCalled();
  });

  it.each([[false, "/hq"], [true, "/hq/change-password"]] as const)("sends an operator to the right page when password change is %s", async (mustChangePassword, destination) => {
    mocks.currentUser.mockResolvedValue({ id: "operator", mustChangePassword });
    await expect(AdminLoginPage()).rejects.toThrow(`REDIRECT:${destination}`);
  });
});
