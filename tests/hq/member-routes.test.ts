// The one member route list: the proxy's cookie-gate bypass and the post-auth
// destination allowlist agree except login pages, which cannot be post-auth
// destinations. Neither may open the operator surface or an external origin.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { isMemberPath, MEMBER_PUBLIC_PATHS, safeMemberNext } from "@/lib/hq/member-routes";
import { safeMemberNext as reExported } from "@/lib/hq/member-auth-config";
import { proxy } from "@/proxy";
import nextConfig from "@/next.config";

const ORIGIN = "https://hq.invalid";
/** Where the proxy sends a cookie-less request, or null when it lets it through. */
const bounce = (pathname: string) => proxy(new NextRequest(`${ORIGIN}${pathname}`)).headers.get("location");

const MEMBER_LOGIN_PAGES = ["/hq/login", "/hq/signin"];
const MEMBER_PAGES = ["/hq/profile", "/hq/welcome", "/hq/dashboard", "/hq/initialize", "/hq/join", "/hq/account", "/hq/captain"];
const DYNAMIC_MEMBER_PAGES = ["/hq/team/00000000-0000-4000-8000-00000000000a", "/hq/team/1234-abcd", "/hq/invite/abc", "/hq/invite/tok_en-42", "/hq/join/917F94-8CE496-4D2C7A-4C70F1"];
const OPERATOR_PAGES = ["/hq", "/hq/admin", "/hq/people", "/hq/projects", "/hq/partners", "/hq/partners/abc", "/hq/events", "/hq/demo", "/hq/select", "/hq/change-password", "/hq/api/search"];

describe("the member route list", () => {
  it("names every member page once, the team and invitation subtrees included, and nothing operator-side", () => {
    expect([...MEMBER_PUBLIC_PATHS].sort()).toEqual([...MEMBER_LOGIN_PAGES, ...MEMBER_PAGES, "/hq/team/", "/hq/invite/", "/hq/join/"].sort());
    expect(new Set(MEMBER_PUBLIC_PATHS).size).toBe(MEMBER_PUBLIC_PATHS.length);
    for (const path of MEMBER_PUBLIC_PATHS) expect(path.startsWith("/hq/"), path).toBe(true);
    expect(MEMBER_PUBLIC_PATHS).not.toContain("/hq/admin/login");
    expect(MEMBER_PUBLIC_PATHS).not.toContain("/hq/signup");
  });

  it.each([...MEMBER_LOGIN_PAGES, ...MEMBER_PAGES, ...DYNAMIC_MEMBER_PAGES])("accepts %s", (path) => {
    expect(isMemberPath(path)).toBe(true);
  });

  it.each([...OPERATOR_PAGES, "/hq/admin/login", "/hq/signup", "/", "/colosseum/start", "/hq/team", "/hq/team/", "/hq/team/a/b", "/hq/team/a.b", "/hq/team/%2e%2e", "/hq/hackathon", "/hq/hackathon/", "/hq/hackathon/41", "/hq/hackathon/a/b", "/hq/hackathon/%2e%2e", "/hq/invite", "/hq/invite/", "/hq/invite/a/b", "/hq/join/", "/hq/join/a/b", "/hq/accounts", "/hq/account/", "/hq/account/other", "/hq/account/add-email", "/hq/account/connect-telegram", "/hq/account/disconnect-telegram", "/hq/captains", "/hq/captain/notes", "/hq/dashboard/", "/hq/Dashboard"])("rejects %s", (path) => {
    expect(isMemberPath(path)).toBe(false);
  });
});

describe("the proxy and the destination allowlist agree", () => {
  it("redirects only the legacy sign-in page permanently to member login", async () => {
    const redirects = await nextConfig.redirects?.();
    expect(redirects?.filter((rule) => rule.source.startsWith("/hq/"))).toEqual([
      { source: "/hq/signin", destination: "/hq/login", permanent: true },
    ]);
  });

  it.each([...MEMBER_PAGES, ...DYNAMIC_MEMBER_PAGES])("both let a member reach %s", (path) => {
    expect(bounce(path)).toBeNull();
    expect(safeMemberNext(path)).toBe(path);
  });

  it.each(OPERATOR_PAGES)("both keep a member off %s", (path) => {
    expect(bounce(path)).toBe(`${ORIGIN}/hq/admin/login`);
    expect(safeMemberNext(path)).toBe("/hq/welcome");
  });

  it("treats the retired per-edition page like any other non-member path", () => {
    expect(bounce("/hq/hackathon/41")).toBe(`${ORIGIN}/hq/admin/login`);
    expect(safeMemberNext("/hq/hackathon/41")).toBe("/hq/welcome");
  });

  it("lets the operator login and the retired signup URL through the cookie gate without making them member destinations", () => {
    expect(bounce("/hq/admin/login")).toBeNull();
    expect(bounce("/hq/signup")).toBeNull();
    expect(safeMemberNext("/hq/admin/login")).toBe("/hq/welcome");
    expect(safeMemberNext("/hq/signup")).toBe("/hq/welcome");
  });

  it.each(MEMBER_LOGIN_PAGES)("lets cookie-less members reach %s without allowing a post-auth loop", (path) => {
    expect(bounce(path)).toBeNull();
    expect(bounce(`${path}?next=%2Fhq%2Fdashboard`)).toBeNull();
    expect(safeMemberNext(path)).toBe("/hq/welcome");
    expect(safeMemberNext(`${path}?next=/hq/dashboard#login`)).toBe("/hq/welcome");
  });

  it("passes an operator cookie to the page's real authorization gate", () => {
    const request = new NextRequest(`${ORIGIN}/hq/admin`, { headers: { cookie: "hq_session=operator-session" } });
    expect(proxy(request).headers.get("location")).toBeNull();
  });

  it.each(["/hq/admin/login/extra", "/hq/login/extra", "/hq/signin/extra"])("does not broaden public login matching to %s", (path) => {
    expect(bounce(path)).toBe(`${ORIGIN}/hq/admin/login`);
    expect(safeMemberNext(path)).toBe("/hq/welcome");
  });

  it("is the same list in both places: neither file keeps a route list of its own", () => {
    const proxySource = readFileSync(join(process.cwd(), "proxy.ts"), "utf8");
    const configSource = readFileSync(join(process.cwd(), "lib/hq/member-auth-config.ts"), "utf8");
    expect(proxySource).toContain("isMemberPath(");
    expect(configSource).toContain('from "./member-routes"');
    // The operator login and the retired signup URL are the proxy's own two exceptions; every member path lives in member-routes.ts.
    for (const path of [...MEMBER_LOGIN_PAGES, ...MEMBER_PAGES, "/hq/team", "/hq/invite"]) {
      expect(proxySource, `proxy.ts lists ${path}`).not.toContain(`"${path}`);
      expect(configSource, `member-auth-config.ts lists ${path}`).not.toContain(`"${path}`);
    }
    expect(reExported).toBe(safeMemberNext);
  });
});

describe("safeMemberNext", () => {
  it.each(["/hq/captain", "/hq/account", "/hq/invite/abc", "/hq/invite/continue", "/hq/dashboard", "/hq/welcome?hackathon=6", "/hq/join?code=abc123", "/hq/initialize", "/hq/team/1234-abcd", "/hq/account?connected=telegram", "/hq/captain?from=nav"])("preserves %s", (value) => {
    expect(safeMemberNext(value)).toBe(value);
  });

  it.each([undefined, null, 42, "", "hq/dashboard", "/hq/login", "/hq/admin", "/hq/people", "/hq/hackathon/41", "//evil", "//evil.example/hq/dashboard", "https://evil", "https://evil.example/hq/dashboard", "/hq/../..", "/hq/dashboard/../../hq/admin", "/hq/dashboard/../admin", "/\\evil.example", "/hq/%61dmin", "/hq/dashboard\n", "/hq/dashboard ", "/hq/account/other", "/hq/account/add-email", "/hq/account/connect-telegram", "/hq/account/disconnect-telegram", "/hq/accounts", "/hq/invite/", "/hq/invite/a/b", "/hq/team/a/b", "javascript:alert(1)"])("rejects %s", (value) => {
    expect(safeMemberNext(value)).toBe("/hq/welcome");
  });

  it("keeps the query, whatever it carries, and drops the fragment", () => {
    expect(safeMemberNext("/hq/captain?tab=1#frag")).toBe("/hq/captain?tab=1");
    // A nested next is just a query value; the page that reads it runs it through safeMemberNext again.
    expect(safeMemberNext("/hq/dashboard?next=//evil")).toBe("/hq/dashboard?next=//evil");
  });

  it.each(["/hq/dashboard/../login", "/hq/dashboard/../signin", "/hq/dashboard/%2e%2e/login?next=/hq/dashboard", "/hq/dashboard/%2e%2e/signin#login"])("rejects login destinations after path normalization: %s", (value) => {
    expect(safeMemberNext(value)).toBe("/hq/welcome");
  });
});
