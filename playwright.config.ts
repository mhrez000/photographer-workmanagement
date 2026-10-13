import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright e2e for the simplified product (docs/SIMPLIFICATION-PLAN.md; ARCHITECTURE §13).
 *
 * Two modes:
 * - `E2E_BASE_URL` set (e.g. `E2E_BASE_URL=http://localhost:3130 npx playwright test`):
 *   run against that already-running server (the shared dev server on the SMALL demo). No web
 *   server is started and no database is touched — the specs create every job/user they need
 *   via the API and assert only on those.
 * - `E2E_BASE_URL` unset (`npm run e2e`): Playwright owns a dev server on :3100 backed by the
 *   PGlite data dir `data/pglite-e2e`. The web server command first resets that database with
 *   the SMALL seed profile (`npm run e2e:prepare` = PGLITE_DATA_DIR=./data/pglite-e2e
 *   SEED_PROFILE=small tsx src/db/reset.ts). Playwright starts `webServer` BEFORE `globalSetup`,
 *   and PGlite allows one process per data dir (the server holds it open), so the reset is
 *   chained in front of the server command instead of living in globalSetup. `DATABASE_URL` is
 *   forced empty so e2e can never reach a remote database. When a server is already listening on
 *   :3100 (`reuseExistingServer`), stop it and run `npm run e2e:prepare && npm run e2e`.
 *
 * Projects: `desktop` (1440×900) runs every spec except mobile.spec.ts; `mobile` (390×844, touch)
 * runs mobile.spec.ts only (plan §3 phone tabs, §5 "pinned next step").
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
    // A 390×844 phone with touch (Pixel 7 user agent and DPR, iPhone-size viewport).
    { name: "mobile", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: externalBaseURL
    ? undefined
    : {
        command: `npm run e2e:prepare && npm run dev -- -p ${OWN_PORT}`,
        url: `http://localhost:${OWN_PORT}/login`,
        reuseExistingServer: true,
        timeout: 240_000,
        env: { PGLITE_DATA_DIR: "./data/pglite-e2e", DATABASE_URL: "", SEED_PROFILE: "small" },
      },
});
