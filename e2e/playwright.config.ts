/**
 * End-to-end suite: the built app in a real browser, on two layouts.
 *
 *   npm run test:e2e            # desktop + both phone sizes
 *   npm run test:e2e:desktop    # one project
 *   npm run test:e2e:mobile
 *   npm run test:e2e:ui         # the same suite, watched live in UI mode
 *   npm run test:e2e:report     # open the last run's screenshots and traces
 *   npm run test:e2e:gallery    # the same screenshots as a slideshow
 *
 * What runs is the production bundle from `npm run build` — the server serves
 * the built UI on one port, exactly as a release does (see support/server.mjs,
 * which also owns the suite's own database and its seeded settings). Build
 * before the first run; the suites' browsers come from `npx playwright install
 * chromium`.
 *
 * One worker on purpose: the app under test is a single server with a single
 * database, so specs that click a global setting must not race each other.
 */
import { defineConfig, devices } from "playwright/test";
import { E2E_BASE_URL, E2E_PORT } from "./support/seed.mjs";

export default defineConfig({
  testDir: "./tests",
  // Everything a failing spec leaves behind (traces, screenshots) stays in the
  // build folder's own tmp, never in the repository.
  outputDir: "../tmp/e2e/artifacts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Locally a run leaves a browsable HTML report (one screenshot per test, a
  // trace with every step) next to the artifacts; CI reads the log instead and
  // uploads the failures.
  reporter: process.env.CI
    ? [["list"], ["github"]]
    : [
        ["list"],
        ["html", { outputFolder: "../tmp/e2e/report", open: "never" }],
        // The slideshow's index (`npm run test:e2e:gallery`): which screenshot
        // and trace each test of this run left behind.
        ["./support/manifest-reporter.mjs"],
      ],
  use: {
    baseURL: E2E_BASE_URL,
    locale: "en-US",
    timezoneId: "UTC",
    trace: process.env.CI ? "retain-on-failure" : "on",
    screenshot: process.env.CI ? "only-on-failure" : "on",
    video: "off",
  },
  projects: [
    {
      name: "desktop",
      testMatch: /desktop\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      testMatch: /mobile\.spec\.ts$/,
      use: { ...devices["Pixel 7"] },
    },
    {
      // The small phone is the one that breaks first: 375×667 has no room for
      // a header that grew by one button or a composer that forgot to shrink.
      // Chromium on purpose: the suite installs one browser, not three.
      name: "mobile-small",
      testMatch: /mobile\.spec\.ts$/,
      use: { ...devices["iPhone SE"], browserName: "chromium" },
    },
  ],
  webServer: {
    command: "node support/server.mjs",
    url: `${E2E_BASE_URL}/api/health`,
    cwd: ".",
    env: { E2E_PORT: String(E2E_PORT) },
    timeout: 180_000,
    // Locally the developer may already have the suite's server running
    // (`node e2e/support/server.mjs`); in CI every run gets a clean one.
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
});
