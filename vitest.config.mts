import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
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
