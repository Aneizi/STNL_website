import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // No test may reach a real database. A DATABASE_URL exported in the
    // shell would otherwise be picked up by an unmocked getSql() or
    // builderDatabase(); a test that needs a value stubs it with vi.stubEnv.
    env: { DATABASE_URL: "", DATABASE_URL_UNPOOLED: "" },
    // Embedded Postgres instances are CPU-heavy during startup. Keep database
    // integration tests reliable on development machines and smaller CI hosts.
    maxWorkers: 2,
  },
  resolve: {
    alias: {
      "@": new URL(".", import.meta.url).pathname,
    },
  },
});
