import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright e2e (spec §40, ARCHITECTURE §13).
 *
 * Two modes:
 * - `E2E_BASE_URL` set (e.g. `E2E_BASE_URL=http://localhost:3130 npx playwright test`):
 *   run against that already-running server. No web server is started and no
 *   database is touched — the specs create every job/user they need via the API.
 * - `E2E_BASE_URL` unset (`npm run e2e`): Playwright owns a dev server on :3100
 *   backed by `data/e2e.db`. The web server command first resets that database
 *   (`npm run e2e:prepare` = DATABASE_PATH=./data/e2e.db tsx src/db/reset.ts).
 *   Playwright starts `webServer` BEFORE `globalSetup`, and SQLite cannot be
 *   deleted while the server holds it open, so the reset is chained in front of
 *   the server command instead of living in globalSetup. When a server is already
 *   listening on :3100 (`reuseExistingServer`), stop it and run
 *   `npm run e2e:prepare && npm run e2e`.
 */
const OWN_PORT = 3100;
const externalBaseURL = process.env.E2E_BASE_URL?.trim() || undefined;
const baseURL = externalBaseURL ?? `http://localhost:${OWN_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Override when several runs share one checkout (each run wipes its outputDir first).
  outputDir: process.env.E2E_OUTPUT_DIR || "test-results",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  // No retries by default: e2e/fixtures.ts mutes the dev server HMR socket, so hot reloads
  // caused by other people editing the checkout no longer reload pages mid-test.
  retries: Number(process.env.E2E_RETRIES ?? 0),
  reporter: [["list"], ["html", { open: "never", outputFolder: process.env.E2E_REPORT_DIR || "playwright-report" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, testIgnore: /mobile\.spec\.ts/ },
    // Spec §28 / §40: a 390×844 phone with touch (Pixel 7 user agent and DPR, iPhone-size viewport).
    { name: "mobile", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: externalBaseURL
    ? undefined
    : {
        command: `npm run e2e:prepare && npm run dev -- -p ${OWN_PORT}`,
        url: `http://localhost:${OWN_PORT}/login`,
        reuseExistingServer: true,
        timeout: 240_000,
        env: { DATABASE_PATH: "./data/e2e.db" },
      },
});
