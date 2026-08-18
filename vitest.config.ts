import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Test pyramid for the whole monorepo:
//   unit (packages/shared, packages/i18n, server helpers, web libs)
//   integration (Fastify inject against the acprocess_test schema,
//                AcpClient against a fake ACP agent process)
//   component (web components in jsdom)
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: [
      "packages/*/src/**/*.test.{ts,tsx}",
      "apps/*/src/**/*.test.{ts,tsx}",
      "apps/server/test/**/*.test.{ts,tsx}",
    ],
    // Each worker process gets its own private in-memory SQLite DB
    // (db/client.ts picks up DATABASE_PATH; setup-env re-asserts it before
    // any module import, so the dev DB file is never touched).
    env: {
      DATABASE_PATH: ":memory:",
    },
    setupFiles: ["apps/server/test/setup-env.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Components need jsdom; the @vitest-environment comment opts in per file.
  },
  resolve: {
    // Keep the shared/i18n workspace exports (raw TS sources) reachable.
    conditions: ["module", "import", "node"],
  },
});
