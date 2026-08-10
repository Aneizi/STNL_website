// Minimal .env loader for standalone scripts (tsx does not load them).
// Files are read in Next.js's own precedence order and the first value found
// wins, so a local database configured for `next dev` is also what these
// scripts target. Values already present in the environment beat both.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENV_FILES = [".env.development.local", ".env.local"];

export function loadEnvLocal() {
  for (const file of ENV_FILES) {
    let raw: string;
    try {
      raw = readFileSync(join(process.cwd(), file), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.replace(/^"([^]*)"$/, "$1");
    }
  }
}

export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`Missing ${key}. Run \`vercel env pull\` first.`);
    process.exit(1);
  }
  return value;
}
