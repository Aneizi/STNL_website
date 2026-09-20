import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const parsedFiles = new Map<string, ts.SourceFile>();

export const parse = (source: string, file = "fixture.ts") =>
  ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);

export function sourceFile(file: string): ts.SourceFile {
  let parsed = parsedFiles.get(file);
  if (!parsed) {
    parsed = parse(readFileSync(join(process.cwd(), file), "utf8"), file);
    parsedFiles.set(file, parsed);
  }
  return parsed;
}

export function hasDirective(source: ts.SourceFile, directive: string): boolean {
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === directive) return true;
  }
  return false;
}

/** Ignore explicit type imports/exports, but include side effects and lazy imports. */
export function runtimeImports(source: ts.SourceFile): Set<string> {
  const specifiers = new Set<string>();
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (!clause || (!clause.isTypeOnly && (clause.name || !bindings || ts.isNamespaceImport(bindings)
        || !bindings.elements.length || bindings.elements.some((element) => !element.isTypeOnly)))) {
        specifiers.add(node.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      if (!clause || ts.isNamespaceExport(clause) || !clause.elements.length || clause.elements.some((element) => !element.isTypeOnly)) {
        specifiers.add(node.moduleSpecifier.text);
      }
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const specifier = node.arguments[0];
      if (specifier && (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier))) {
        specifiers.add(specifier.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return specifiers;
}
