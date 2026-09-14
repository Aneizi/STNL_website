// The mirror of tests/hq/member-shell.test.ts: that scan keeps the member
// shell free of operator modules, this one keeps the operator Server Actions
// free of the public member auth graph. The coupling this guards against was
// transitive (actions/*.ts -> actions/util.ts -> authz.ts -> actor.ts ->
// member-auth.ts), so the scan follows the graph instead of stopping at the
// direct imports.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/** The member side of lib/hq/actions; everything else there is operator gated (tests/hq/auth-boundary.test.ts holds the gate map). */
const MEMBER_ACTIONS = new Set(["builders.ts", "invite.ts", "reporting.ts", "telegram.ts"]);

/** Reached only through the public member session. An operator action that needs one of these is a boundary change, not an import. */
const FORBIDDEN_MODULES = ["lib/hq/member-auth.ts", "lib/hq/telegram-identity-plugin.ts", "lib/hq/telegram-provider.ts"];

/** Packages only the public member auth graph uses. They inflate every operator route bundle that reaches them. */
const FORBIDDEN_PACKAGES = /^(better-auth(\/|$)|@better-auth\/|resend$)/;

function actionModules(): string[] {
  return readdirSync(join(ROOT, "lib/hq/actions"))
    .filter((name) => name.endsWith(".ts") && readFileSync(join(ROOT, "lib/hq/actions", name), "utf8").startsWith('"use server"'))
    .sort();
}

/**
 * Every module and package the file reaches, following runtime imports
 * transitively. Type-only imports are erased by the compiler and skipped, the
 * same regex the member-shell scan uses.
 */
function reachable(entry: string): { modules: Set<string>; packages: Set<string> } {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    const source = readFileSync(join(ROOT, file), "utf8");
    for (const match of source.matchAll(/^\s*(?:import|export)\s+(?!type\s)[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
      const specifier = match[1];
      if (!specifier.startsWith("@/") && !specifier.startsWith(".")) {
        packages.add(specifier);
        continue;
      }
      const base = specifier.startsWith("@/") ? specifier.slice(2) : posix.normalize(posix.join(posix.dirname(file), specifier));
      const resolved = [".ts", ".tsx", "/index.ts"].map((extension) => base + extension).find((candidate) => existsSync(join(ROOT, candidate)));
      expect(resolved, `${file} imports ${specifier}, which resolves to no file`).toBeDefined();
      if (!modules.has(resolved!)) {
        modules.add(resolved!);
        queue.push(resolved!);
      }
    }
  }
  return { modules, packages };
}

describe("the operator server actions import nothing from the public member auth graph", () => {
  const files = actionModules();

  it("finds the action modules and separates the two member ones", () => {
    expect(files.length).toBeGreaterThanOrEqual(12);
    for (const name of MEMBER_ACTIONS) expect(files).toContain(name);
  });

  for (const name of files.filter((file) => !MEMBER_ACTIONS.has(file))) {
    it(`lib/hq/actions/${name}`, () => {
      const { modules, packages } = reachable(`lib/hq/actions/${name}`);
      for (const forbidden of FORBIDDEN_MODULES) expect([...modules], `lib/hq/actions/${name} reaches ${forbidden}`).not.toContain(forbidden);
      for (const packageName of packages) expect(FORBIDDEN_PACKAGES.test(packageName), `lib/hq/actions/${name} reaches ${packageName}`).toBe(false);
    });
  }

  // Without this the scan above could pass by finding nothing at all.
  it("does reach member-auth from the member action modules, so the walk is real", () => {
    for (const name of MEMBER_ACTIONS) {
      expect([...reachable(`lib/hq/actions/${name}`).modules], name).toContain("lib/hq/member-auth.ts");
    }
  });

  // Phase 6 needed the reporting service from an operator action, and
  // lib/hq/authz.ts reaches ./actor (and through it ./member-auth) for
  // requireOperator() alone. The decisions moved to the session-free
  // ./authz-decisions, which ./authz re-exports unchanged; if that edge ever
  // comes back, every operator action module above fails, and so does this.
  it("keeps the authorization decisions session-free, so the reporting service stays operator-safe", () => {
    const { modules } = reachable("lib/hq/reporting.ts");
    expect([...modules]).toContain("lib/hq/authz-decisions.ts");
    for (const forbidden of FORBIDDEN_MODULES) expect([...modules]).not.toContain(forbidden);
    expect([...reachable("lib/hq/authz-decisions.ts").modules]).not.toContain("lib/hq/actor.ts");
    // ./authz still carries requireOperator, and still reaches the member
    // graph because of it: the split is what keeps that off the reporting
    // side, not a claim that ./authz became a leaf.
    expect([...reachable("lib/hq/authz.ts").modules]).toContain("lib/hq/member-auth.ts");
  });

  it("keeps assertHackathonMatches in the leaf module, re-exported through authz", () => {
    expect(readFileSync(join(ROOT, "lib/hq/authz-sql.ts"), "utf8")).toContain("export function assertHackathonMatches");
    // Re-exported by the decisions module and again by ./authz, so a caller
    // still finds it where the contract says it is. The definition stays in
    // the leaf either way, which is what actions/util.ts imports.
    expect(readFileSync(join(ROOT, "lib/hq/authz-decisions.ts"), "utf8")).toMatch(/export \{[^}]*assertHackathonMatches[^}]*\} from "\.\/authz-sql"/);
    expect(readFileSync(join(ROOT, "lib/hq/authz.ts"), "utf8")).toMatch(/export \{[^}]*assertHackathonMatches[^}]*\} from "\.\/authz-decisions"/);
    expect(readFileSync(join(ROOT, "lib/hq/actions/util.ts"), "utf8")).toContain('from "../authz-sql"');
  });
});
