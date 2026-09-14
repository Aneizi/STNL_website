// next.config.ts's headers() entry for the Captain invitation flow: it must
// actually cover both /hq/invite/[token] and /hq/invite/continue, checked
// against the exact semantics Next's own docs give a trailing `:path*`
// segment ("/blog/:slug*" matches "/blog", "/blog/a" and "/blog/a/b/c" —
// node_modules/next/dist/docs/.../file-conventions/config/next-config-js/headers.md),
// so a change to the `source` pattern that quietly stops covering one of the
// two routes fails here. Deliberately narrow rather than pulling in Next's
// own path-to-regexp: that copy lives under next/dist/compiled with no
// published types and no public API contract, worse for a repo test to
// depend on than a few lines mirroring one documented, simple shape.
//
// This proves the config entry itself — it does not and cannot prove the
// header lands on the real redirect response, since headers() is applied by
// Next's own server layer, below anything a unit test drives directly. That
// needs a manual `curl -I https://<dev-server>/hq/invite/<token>` against a
// running dev server; see the task report for why this is not claimed here.
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

/** Exactly the semantics Next's docs give a trailing `/:name*` segment: matches the prefix itself and anything nested under it. */
function matchesTrailingWildcard(source: string, pathname: string): boolean {
  const suffix = "/:path*";
  if (!source.endsWith(suffix)) throw new Error(`this check only understands a trailing ${suffix} segment`);
  const prefix = source.slice(0, -suffix.length);
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

async function inviteHeaderEntries() {
  const entries = (await nextConfig.headers!()) ?? [];
  return entries.filter((entry) => entry.source.startsWith("/hq/invite"));
}

describe("next.config.ts headers() for /hq/invite", () => {
  it("has exactly one entry, matching both the token exchange route and the continuation page", async () => {
    const entries = await inviteHeaderEntries();
    expect(entries).toHaveLength(1);
    const { source } = entries[0];
    expect(matchesTrailingWildcard(source, "/hq/invite/aBc123-token")).toBe(true);
    expect(matchesTrailingWildcard(source, "/hq/invite/continue")).toBe(true);
    // Never wider than the invitation subtree.
    expect(matchesTrailingWildcard(source, "/hq/account")).toBe(false);
    expect(matchesTrailingWildcard(source, "/hq/captain")).toBe(false);
  });

  it("sets Referrer-Policy: no-referrer and X-Robots-Tag: noindex, noarchive", async () => {
    const [entry] = await inviteHeaderEntries();
    expect(entry.headers).toEqual(
      expect.arrayContaining([
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Robots-Tag", value: "noindex, noarchive" },
      ]),
    );
  });
});
