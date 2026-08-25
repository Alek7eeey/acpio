import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Test pyramid for the whole monorepo:
//   unit (packages/shared, packages/i18n, server helpers, web libs)
//   integration (Fastify inject against the acpio_test schema,
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
    // Workspace packages export built dist by default (prod/Node) and raw TS
    // sources under the "development" condition — keep tests on the freshest
    // sources, like the tsx/vite dev servers do.
    conditions: ["development", "module", "import", "node"],
  },
});
