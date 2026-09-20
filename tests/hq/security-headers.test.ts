import { afterEach, describe, expect, it, vi } from "vitest";
import { getRewrittenUrl, unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import nextConfig from "@/next.config";

afterEach(() => vi.unstubAllEnvs());

async function response(path: string) {
  return unstable_getResponseFromNextConfig({ url: `https://hq.test${path}`, nextConfig });
}

describe("response security without changing resource loading", () => {
  it.each(["/hq", "/hq/projects", "/hq/login", "/hq/team/example"])("protects %s from framing", async (path) => {
    const result = await response(path);
    expect(result.headers.get("X-Frame-Options")).toBe("DENY");
    expect(result.headers.get("Content-Security-Policy"))
      .toBe("frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    expect(result.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it.each(["/hq/join/secret", "/hq/invite/secret", "/hq/invite/continue"])("keeps bearer-flow privacy for %s", async (path) => {
    const result = await response(path);
    expect(result.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(result.headers.get("X-Robots-Tag")).toBe("noindex, noarchive");
  });

  it("preserves the public deck rewrite and its resource policy", async () => {
    const result = await response("/pitch-deck");
    expect(getRewrittenUrl(result)).toBe("https://hq.test/deck/index.html");
    expect(result.headers.get("Content-Security-Policy")).toBeNull();
    expect(result.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("enables transport security only for HTTPS Vercel deployments", async () => {
    vi.stubEnv("VERCEL", "1");
    expect((await response("/")).headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
    vi.stubEnv("VERCEL", "");
    expect((await response("/")).headers.get("Strict-Transport-Security")).toBeNull();
  });
});
