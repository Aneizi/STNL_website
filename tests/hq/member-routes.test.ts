// The one member route list: the proxy's cookie-gate bypass and the post-auth
// destination allowlist must agree, and neither may open the operator surface
// or an external origin.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { isMemberPath, MEMBER_PUBLIC_PATHS, safeMemberNext } from "@/lib/hq/member-routes";
import { safeMemberNext as reExported } from "@/lib/hq/member-auth-config";
import { proxy } from "@/proxy";

const ORIGIN = "https://hq.invalid";
/** Where the proxy sends a cookie-less request, or null when it lets it through. */
const bounce = (pathname: string) => proxy(new NextRequest(`${ORIGIN}${pathname}`)).headers.get("location");

const MEMBER_PAGES = ["/hq/signin", "/hq/profile", "/hq/welcome", "/hq/dashboard", "/hq/initialize", "/hq/join", "/hq/account", "/hq/account/connect-telegram", "/hq/account/disconnect-telegram", "/hq/account/add-email", "/hq/captain"];
const DYNAMIC_MEMBER_PAGES = ["/hq/team/00000000-0000-4000-8000-00000000000a", "/hq/team/1234-abcd", "/hq/invite/abc", "/hq/invite/tok_en-42"];
const OPERATOR_PAGES = ["/hq", "/hq/admin", "/hq/people", "/hq/projects", "/hq/partners", "/hq/partners/abc", "/hq/events", "/hq/links", "/hq/demo", "/hq/select", "/hq/change-password", "/hq/api/search"];

describe("the member route list", () => {
  it("names every member page once, the team and invitation subtrees included, and nothing operator-side", () => {
    expect([...MEMBER_PUBLIC_PATHS].sort()).toEqual([...MEMBER_PAGES, "/hq/team/", "/hq/invite/"].sort());
    expect(new Set(MEMBER_PUBLIC_PATHS).size).toBe(MEMBER_PUBLIC_PATHS.length);
    for (const path of MEMBER_PUBLIC_PATHS) expect(path.startsWith("/hq/"), path).toBe(true);
    expect(MEMBER_PUBLIC_PATHS).not.toContain("/hq/login");
    expect(MEMBER_PUBLIC_PATHS).not.toContain("/hq/signup");
  });

  it.each([...MEMBER_PAGES, ...DYNAMIC_MEMBER_PAGES])("accepts %s", (path) => {
    expect(isMemberPath(path)).toBe(true);
  });

  it.each([...OPERATOR_PAGES, "/hq/login", "/hq/signup", "/", "/colosseum/start", "/hq/team", "/hq/team/", "/hq/team/a/b", "/hq/team/a.b", "/hq/team/%2e%2e", "/hq/invite", "/hq/invite/", "/hq/invite/a/b", "/hq/accounts", "/hq/account/", "/hq/account/other", "/hq/captains", "/hq/dashboard/", "/hq/Dashboard"])("rejects %s", (path) => {
    expect(isMemberPath(path)).toBe(false);
  });
});

describe("the proxy and the destination allowlist agree", () => {
  it.each([...MEMBER_PAGES, ...DYNAMIC_MEMBER_PAGES])("both let a member reach %s", (path) => {
    expect(bounce(path)).toBeNull();
    expect(safeMemberNext(path)).toBe(path);
  });

  it.each(OPERATOR_PAGES)("both keep a member off %s", (path) => {
    expect(bounce(path)).toBe(`${ORIGIN}/hq/login`);
    expect(safeMemberNext(path)).toBe("/hq/welcome");
  });

  it("lets the operator login and the retired signup URL through the cookie gate without making them member destinations", () => {
    expect(bounce("/hq/login")).toBeNull();
    expect(bounce("/hq/signup")).toBeNull();
    expect(safeMemberNext("/hq/login")).toBe("/hq/welcome");
    expect(safeMemberNext("/hq/signup")).toBe("/hq/welcome");
  });

  it("is the same list in both places: neither file keeps a route list of its own", () => {
    const proxySource = readFileSync(join(process.cwd(), "proxy.ts"), "utf8");
    const configSource = readFileSync(join(process.cwd(), "lib/hq/member-auth-config.ts"), "utf8");
    expect(proxySource).toContain("isMemberPath(");
    expect(configSource).toContain('from "./member-routes"');
    // The operator login and the retired signup URL are the proxy's own two exceptions; every member path lives in member-routes.ts.
    for (const path of [...MEMBER_PAGES, "/hq/team", "/hq/invite"]) {
      expect(proxySource, `proxy.ts lists ${path}`).not.toContain(`"${path}`);
      expect(configSource, `member-auth-config.ts lists ${path}`).not.toContain(`"${path}`);
    }
    expect(reExported).toBe(safeMemberNext);
  });
});

describe("safeMemberNext", () => {
  it.each(["/hq/captain", "/hq/account", "/hq/invite/abc", "/hq/dashboard", "/hq/welcome?hackathon=6", "/hq/join?code=abc123", "/hq/initialize", "/hq/team/1234-abcd", "/hq/account?connected=telegram", "/hq/account/connect-telegram", "/hq/account/disconnect-telegram", "/hq/account/add-email", "/hq/captain?from=nav"])("preserves %s", (value) => {
    expect(safeMemberNext(value)).toBe(value);
  });

  it.each([undefined, null, 42, "", "hq/dashboard", "/hq/login", "/hq/admin", "/hq/people", "//evil", "//evil.example/hq/dashboard", "https://evil", "https://evil.example/hq/dashboard", "/hq/../..", "/hq/dashboard/../../hq/admin", "/hq/dashboard/../admin", "/\\evil.example", "/hq/%61dmin", "/hq/dashboard\n", "/hq/dashboard ", "/hq/account/other", "/hq/accounts", "/hq/invite/", "/hq/invite/a/b", "/hq/team/a/b", "javascript:alert(1)"])("rejects %s", (value) => {
    expect(safeMemberNext(value)).toBe("/hq/welcome");
  });

  it("keeps the query, whatever it carries, and drops the fragment", () => {
    expect(safeMemberNext("/hq/captain?tab=1#frag")).toBe("/hq/captain?tab=1");
    // A nested next is just a query value; the page that reads it runs it through safeMemberNext again.
    expect(safeMemberNext("/hq/dashboard?next=//evil")).toBe("/hq/dashboard?next=//evil");
  });
});
