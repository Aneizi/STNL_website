// Follow runtime imports transitively: an indirect member-auth dependency is
// still an operator boundary violation, even when hidden behind a barrel.
import { existsSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { hasDirective, parse, runtimeImports, sourceFile } from "./helpers/module-source";

const ROOT = process.cwd();

/** The member side of lib/hq/actions; everything else there is operator gated (tests/hq/auth-boundary.test.ts holds the gate map). */
const MEMBER_ACTIONS = new Set(["builders.ts", "invite.ts", "reporting.ts", "telegram.ts"]);

/** Reached only through the public member session. An operator action that needs one of these is a boundary change, not an import. */
const FORBIDDEN_MODULES = ["lib/hq/member-auth.ts", "lib/hq/telegram-identity-plugin.ts", "lib/hq/telegram-provider.ts"];

/** Packages only the public member auth graph uses. They inflate every operator route bundle that reaches them. */
const FORBIDDEN_PACKAGES = /^(better-auth(\/|$)|@better-auth\/|resend$)/;

function reexports(file: string, module: string, name: string): boolean {
  return sourceFile(file).statements.some((node) => ts.isExportDeclaration(node) && !node.isTypeOnly
    && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === module
    && node.exportClause && ts.isNamedExports(node.exportClause)
    && node.exportClause.elements.some((element) => !element.isTypeOnly && element.name.text === name
      && (element.propertyName?.text ?? element.name.text) === name));
}

function actionModules(): string[] {
  return readdirSync(join(ROOT, "lib/hq/actions"))
    .filter((name) => name.endsWith(".ts") && hasDirective(sourceFile(`lib/hq/actions/${name}`), "use server"))
    .sort();
}

/** Every runtime module and package the entry reaches, regardless of formatting. */
function reachable(entry: string): { modules: Set<string>; packages: Set<string> } {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    for (const specifier of runtimeImports(sourceFile(file))) {
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

  it("finds the action modules and separates the member actions", () => {
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

  it("keeps the authorization decisions session-free, so the reporting service stays operator-safe", () => {
    const { modules } = reachable("lib/hq/reporting.ts");
    expect([...modules]).toContain("lib/hq/authz-decisions.ts");
    for (const forbidden of FORBIDDEN_MODULES) expect([...modules]).not.toContain(forbidden);
    expect([...reachable("lib/hq/authz-decisions.ts").modules]).not.toContain("lib/hq/actor.ts");
    expect([...reachable("lib/hq/authz.ts").modules]).not.toContain("lib/hq/member-auth.ts");
  });

  it("keeps assertHackathonMatches in the leaf module, re-exported through authz", () => {
    expect(sourceFile("lib/hq/authz-sql.ts").statements.some((node) => ts.isFunctionDeclaration(node)
      && node.name?.text === "assertHackathonMatches" && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))).toBe(true);
    expect(reexports("lib/hq/authz-decisions.ts", "./authz-sql", "assertHackathonMatches")).toBe(true);
    expect(reexports("lib/hq/authz.ts", "./authz-decisions", "assertHackathonMatches")).toBe(true);
    expect(runtimeImports(sourceFile("lib/hq/actions/util.ts"))).toContain("../authz-sql");
  });
});

describe("the module boundary scanner", () => {
  it("recognizes directives after comments and independent of quote style", () => {
    expect(hasDirective(parse("// module comment\n'use strict';\n'use server';\nexport async function action() {}"), "use server")).toBe(true);
    expect(hasDirective(parse('/* module comment */\n"use client";\nexport const Component = () => null;'), "use client")).toBe(true);
    expect(hasDirective(parse("const description = 'use server';"), "use server")).toBe(false);
    expect(hasDirective(parse("const value = 1;\n'use client';"), "use client")).toBe(false);
  });

  it("ignores comments and explicit type-only imports and re-exports", () => {
    expect([...runtimeImports(parse(`
      // import { fake } from "comment";
      import type { Actor } from "type-import";
      import { type Actor as OtherActor } from "named-type-import";
      export type { Actor } from "type-export";
      export { type Actor as Alias } from "named-type-export";
      const example = 'import { fake } from "string"';
    `))]).toEqual([]);
  });

  it("follows runtime imports, re-exports, side effects and lazy imports", () => {
    expect([...runtimeImports(parse(`
      import 'server-only';
      import {} from 'empty-import';
      import Default, { type Shape, value } from 'mixed';
      import * as namespace from 'namespace';
      export { value as renamed, type Shape } from 'reexport';
      export * from 'barrel';
      export * as nested from 'namespace-export';
      export {} from 'empty-export';
      const load = () => import('lazy');
      const loaded = require('required');
    `))]).toEqual(['server-only', 'empty-import', 'mixed', 'namespace', 'reexport', 'barrel', 'namespace-export', 'empty-export', 'lazy', 'required']);
  });
});
