import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // eslint-config-next's own rule (typescript.js) is 'warn' with no
    // options, so a leading underscore on an otherwise-required parameter
    // (a useActionState previous-state argument, a Server Action's unused
    // formData) still warns unless it is followed by a used one. This keeps
    // the underscore convention already in use across the repo (e.g.
    // lib/hq/actions/auth.ts's login(_prev, formData)) from being purely
    // cosmetic.
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
