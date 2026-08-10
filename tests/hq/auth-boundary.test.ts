// The HQ auth boundary lives in every page, server action, and route
// handler (layouts don't re-render on soft navigation). These checks scan
// the source so an accidentally unguarded surface fails CI instead of
// shipping.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

describe("every /hq page and route handler checks the session", () => {
  const files = walk(join(ROOT, "app/hq")).filter(
    (file) => file.endsWith("page.tsx") || file.endsWith("route.ts"),
  );

  it("finds the HQ surface", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  for (const file of files) {
    it(relative(ROOT, file), () => {
      const source = readFileSync(file, "utf8");
      expect(source).toMatch(/\b(requireUser|currentUser)\(/);
    });
  }
});

describe("every server action authenticates", () => {
  // login is the rate-limited public entry point; logout only destroys the
  // caller's own session.
  const PUBLIC = new Set(["auth.ts:login", "auth.ts:logout"]);

  const files = walk(join(ROOT, "lib/hq/actions")).filter((file) => {
    if (!file.endsWith(".ts")) return false;
    return readFileSync(file, "utf8").startsWith('"use server"');
  });

  it("finds the action modules", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const matches = [...source.matchAll(/export async function (\w+)/g)];
    for (const [index, match] of matches.entries()) {
      const name = `${basename(file)}:${match[1]}`;
      if (PUBLIC.has(name)) continue;
      const body = source.slice(
        match.index,
        index + 1 < matches.length ? matches[index + 1].index : source.length,
      );
      it(name, () => {
        // requireUser redirects; the currentUser variant is the null-guard
        // pattern used by actions that respond instead of redirecting.
        expect(body).toMatch(/\b(requireUser|currentUser)\(/);
      });
    }
  }
});
