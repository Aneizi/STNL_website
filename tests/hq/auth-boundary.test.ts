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

type Gate = "operator" | "member";

// The two session origins and their gate spellings. The operator gate is
// requireUser (redirects), currentUser (the null-guard variant for surfaces
// that respond instead of redirecting) or the actor wrapper over them; the
// member gate is requireMember, currentMember or the member actor wrapper.
// A public account never passes an operator gate and vice versa.
const GATES: Record<Gate, RegExp> = {
  operator: /\b(requireUser|currentUser|requireOperatorActor)\(/,
  member: /\b(requireMember|currentMember|requireMemberActor)\(/,
};

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
      const isMember = relative(ROOT, file).startsWith("app/hq/(member)/");
      expect(source).toMatch(isMember ? GATES.member : GATES.operator);
    });
  }
});

describe("every server action authenticates", () => {
  // Every "use server" module under lib/hq/actions and the gate each of its
  // exports must call. A new module must be added here with its gate: an
  // unknown file fails, and so does a mapped file that no longer exists.
  const ACTION_GATES: Record<string, Gate> = {
    "admin.ts": "operator",
    "auth.ts": "operator",
    "builders-admin.ts": "operator",
    "builders.ts": "member",
    "capabilities.ts": "operator",
    "captains.ts": "operator",
    "demo.ts": "operator",
    "events.ts": "operator",
    "hackathons.ts": "operator",
    "links.ts": "operator",
    "overlay.ts": "operator",
    "partners.ts": "operator",
    "people.ts": "operator",
    "projects.ts": "operator",
    "telegram.ts": "member",
  };

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

  it("maps every action module to a gate, and only existing modules", () => {
    expect(files.map((file) => basename(file)).sort()).toEqual(Object.keys(ACTION_GATES).sort());
  });

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const gate = ACTION_GATES[basename(file)];
    const matches = [...source.matchAll(/export async function (\w+)/g)];
    for (const [index, match] of matches.entries()) {
      const name = `${basename(file)}:${match[1]}`;
      if (PUBLIC.has(name)) continue;
      const body = source.slice(
        match.index,
        index + 1 < matches.length ? matches[index + 1].index : source.length,
      );
      it(name, () => {
        expect(gate, `${basename(file)} is not in the gate map`).toBeDefined();
        expect(body).toMatch(GATES[gate]);
      });
    }
  }
});
