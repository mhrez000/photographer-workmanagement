import fs from "node:fs";
import path from "node:path";
import type { FullConfig } from "@playwright/test";
import { AUTH_DIR } from "./api";

const STALE_MS = 60 * 60 * 1000;

/**
 * Runs once per `playwright test` invocation (after the web server is up —
 * Playwright starts `webServer` before `globalSetup`, which is why the DB reset
 * is chained into the web server command, see playwright.config.ts).
 *
 * - Prunes storage states older than an hour (fresh ones are written per worker,
 *   named by pid, so concurrent runs never share or delete each other's files).
 * - Fails fast with a readable message when the target server is not reachable.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  for (const file of fs.readdirSync(AUTH_DIR)) {
    const full = path.join(AUTH_DIR, file);
    try {
      if (Date.now() - fs.statSync(full).mtimeMs > STALE_MS) fs.rmSync(full, { force: true });
    } catch {
      // another run removed it first
    }
  }

  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("e2e: no baseURL configured");
  try {
    const res = await fetch(new URL("/login", baseURL), { redirect: "manual" });
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    throw new Error(`e2e: server at ${baseURL} is not reachable (${(err as Error).message}). Start it or unset E2E_BASE_URL.`);
  }
}
