/**
 * The e2e fixtures module: role-based fixtures + shared UI helpers.
 *
 * - Each role logs in ONCE per worker through the REST API
 *   (`POST /api/auth/login` with an Origin header) and its storage state is
 *   saved to `e2e/.auth/<role>.json` (gitignored).
 * - `test.use({ role: "editor" })` makes the default `page` that user.
 * - `pageAs(role)` opens an extra, isolated browser context for multi-user flows.
 * - `api` (as the owner) and `apiAs(role)` are authenticated REST clients for
 *   setup and server-side verification.
 */
import fs from "node:fs";
import { test as base, expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { AUTH_DIR, Api, DEMO_PASSWORD, ROLE_EMAILS, authFile, baseUrl, escapeRegExp, loginApi, newApi, type Role } from "./api";

async function loginAndSave(email: string, password: string, file: string): Promise<void> {
  const api = await loginApi(email, password);
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    await api.ctx.storageState({ path: file });
  } finally {
    await api.ctx.dispose();
  }
}

/** Storage state for a credentials pair (created users), cached per email. */
export async function storageFor(email: string, password: string): Promise<string> {
  const file = authFile(`user-${email.replace(/[^a-z0-9]+/gi, "_")}`);
  await loginAndSave(email, password, file);
  return file;
}

interface WorkerFixtures {
  /** Returns the storage-state path for a seeded role, logging in on first use in this worker. */
  authState: (role: Role) => Promise<string>;
  /** Owner REST client (worker-scoped, so beforeAll hooks can use it). */
  api: Api;
}

interface TestFixtures {
  /** Who the default `page` is signed in as; "anon" = no session. */
  role: Role | "anon";
  apiAs: (role: Role) => Promise<Api>;
  /** REST client for a created user (email + temp password); disposed after the test. */
  loginAs: (email: string, password: string) => Promise<Api>;
  /** Fresh browser context + page signed in as `role` (closed after the test). */
  pageAs: (role: Role) => Promise<Page>;
  /** Fresh browser context + page signed in with a storage-state file (created users). */
  pageWithState: (storageState: string | undefined) => Promise<Page>;
}

/**
 * The dev server's HMR socket triggers full page reloads whenever any source
 * file changes (other people editing the same checkout), which closes menus
 * and dialogs mid-test. The socket is proxied to the real server (Next 16 dev
 * needs it to finish booting the client — a dead socket leaves pages
 * non-interactive) but messages that reload or patch the page are dropped.
 * Set E2E_KEEP_HMR=1 to keep the raw socket.
 */
const HMR_RELOAD_TYPES = new Set([
  "reloadPage",
  "serverComponentChanges",
  "turbopack-message",
  "clientChanges",
  "serverOnlyChanges",
  "middlewareChanges",
  "addedPage",
  "removedPage",
  "staticParamsChanged",
]);

function isReloadMessage(message: string | Buffer): boolean {
  if (typeof message !== "string") return false;
  try {
    const parsed = JSON.parse(message) as { type?: unknown };
    return typeof parsed.type === "string" && HMR_RELOAD_TYPES.has(parsed.type);
  } catch {
    return false;
  }
}

export async function muteHmr(context: BrowserContext): Promise<void> {
  if (process.env.E2E_KEEP_HMR) return;
  await context.routeWebSocket(new RegExp("/_next/(webpack-)?hmr"), (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      if (!isReloadMessage(message)) ws.send(message);
    });
    ws.onMessage((message) => server.send(message));
  });
}

/**
 * Resolves once React has hydrated the page: hydrated DOM nodes carry a
 * `__reactFiber$…` key. In `next dev` a server-rendered button is visible
 * (and clickable for Playwright) seconds before its handler is attached, so a
 * click that lands earlier is silently lost.
 */
export async function waitForHydration(page: Page, timeout = 45_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const probe = document.querySelector("main button, main a[href], header button, button");
      return Boolean(probe && Object.keys(probe).some((k) => k.startsWith("__reactFiber")));
    },
    undefined,
    { timeout },
  );
}

/** Makes `page.goto` / `page.reload` wait for hydration (see waitForHydration). */
function hydrateOnNavigate(page: Page): void {
  const goto = page.goto.bind(page);
  const reload = page.reload.bind(page);
  page.goto = async (url, options) => {
    const res = await goto(url, options);
    await waitForHydration(page).catch(() => undefined);
    return res;
  };
  page.reload = async (options) => {
    const res = await reload(options);
    await waitForHydration(page).catch(() => undefined);
    return res;
  };
}

/** Test-context setup shared by every browser context the fixtures create. */
async function prepareContext(context: BrowserContext): Promise<void> {
  await muteHmr(context);
  for (const p of context.pages()) hydrateOnNavigate(p);
  context.on("page", hydrateOnNavigate);
}

async function newContextLike(browser: Browser, contextOptions: Parameters<Browser["newContext"]>[0], storageState?: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({ ...contextOptions, baseURL: baseUrl(), storageState });
  await prepareContext(ctx);
  return ctx;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  authState: [
    async ({}, use) => {
      const done = new Map<Role, Promise<string>>();
      await use((role: Role) => {
        let p = done.get(role);
        if (!p) {
          const file = authFile(role);
          p = loginAndSave(ROLE_EMAILS[role], DEMO_PASSWORD, file).then(() => file);
          done.set(role, p);
        }
        return p;
      });
    },
    { scope: "worker" },
  ],

  role: ["owner", { option: true }],

  context: async ({ context }, use) => {
    await prepareContext(context);
    await use(context);
  },

  storageState: async ({ role, authState }, use) => {
    await use(role === "anon" ? { cookies: [], origins: [] } : await authState(role));
  },

  api: [
    async ({ authState }, use) => {
      const api = await newApi(await authState("owner"));
      await use(api);
      await api.ctx.dispose();
    },
    { scope: "worker" },
  ],

  apiAs: async ({ authState }, use) => {
    const made: Api[] = [];
    await use(async (role: Role) => {
      const api = await newApi(await authState(role));
      made.push(api);
      return api;
    });
    for (const a of made) await a.ctx.dispose();
  },

  loginAs: async ({}, use) => {
    const made: Api[] = [];
    await use(async (email: string, password: string) => {
      const api = await loginApi(email, password);
      made.push(api);
      return api;
    });
    for (const a of made) await a.ctx.dispose();
  },

  pageAs: async ({ browser, authState, contextOptions, viewport, userAgent, isMobile, hasTouch, deviceScaleFactor }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (role: Role) => {
      const ctx = await newContextLike(
        browser,
        { ...contextOptions, viewport, userAgent, isMobile, hasTouch, deviceScaleFactor },
        await authState(role),
      );
      contexts.push(ctx);
      return ctx.newPage();
    });
    for (const c of contexts) await c.close();
  },

  pageWithState: async ({ browser, contextOptions, viewport, userAgent, isMobile, hasTouch, deviceScaleFactor }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (storageState) => {
      const ctx = await newContextLike(browser, { ...contextOptions, viewport, userAgent, isMobile, hasTouch, deviceScaleFactor }, storageState);
      contexts.push(ctx);
      return ctx.newPage();
    });
    for (const c of contexts) await c.close();
  },
});

export { expect, escapeRegExp };

/* ------------------------------ UI helpers ------------------------------ */

/** Opens a job detail page (optionally a tab) and waits for the header. */
export async function openJob(page: Page, jobId: string, tab?: string): Promise<void> {
  await page.goto(`/jobs/${jobId}${tab ? `?tab=${tab}` : ""}`);
  await expect(jobHeading(page)).toBeVisible();
}

/** The job detail page heading ("PJ-0142 Smith St"); the topbar has its own h1. */
export function jobHeading(page: Page) {
  return page.getByRole("heading", { level: 1, name: /PJ-\d+/ });
}

/** The History tab's timeline list. */
export function historyList(page: Page) {
  return page.getByRole("list", { name: "Job history" });
}

/**
 * Opens a searchable combobox (button trigger → popover with a search input and
 * a listbox), types `text` and picks the first option containing it.
 */
export async function pickFromCombobox(page: Page, trigger: ReturnType<Page["getByRole"]>, text: string): Promise<void> {
  await expect(trigger).toBeEnabled();
  await trigger.click();
  const search = page.getByRole("combobox").and(page.locator('input[aria-autocomplete="list"]'));
  await search.fill(text);
  await page.getByRole("option", { name: text }).first().click();
  await expect(trigger).toContainText(text);
}

/** A job card in My Work (an <article> labelled by the job name). */
export function myWorkCard(page: Page, jobName: string) {
  return page.getByRole("article", { name: new RegExp(escapeRegExp(jobName)) });
}

/* ----------------------- dev-server tolerance ----------------------- */

/**
 * Specs run against `next dev`: first compiles are slow and server-rendered
 * markup is visible before hydration. UI-heavy tests raise their timeout and
 * retry interactive steps until they take effect.
 */
export const UI_TEST_TIMEOUT = 240_000;

/** Navigate and wait until `ready` is visible (server-rendered content is enough). */
export async function gotoReady(page: Page, url: string, ready: Locator): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(ready).toBeVisible({ timeout: 90_000 });
}

/** Re-run `fn` until it passes (each attempt should use short inner timeouts). */
export async function retrying(fn: () => Promise<void>, timeout = 120_000): Promise<void> {
  await expect(fn).toPass({ timeout, intervals: [500, 1_000, 2_000, 4_000] });
}

/* ---------------------------- layout checks ---------------------------- */

/** The document never scrolls sideways (the shell's own scrollers may). */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `page is ${scrollWidth}px wide in a ${clientWidth}px viewport`).toBeLessThanOrEqual(clientWidth);
}

/** The element's box lies inside the viewport horizontally (1px tolerance for subpixel rounding). */
export async function expectInsideViewportX(page: Page, locator: Locator, what: string): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, `${what} has no box`).not.toBeNull();
  const width = page.viewportSize()?.width ?? 0;
  expect(box!.x, `${what} starts left of the viewport`).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width, `${what} ends past the ${width}px viewport`).toBeLessThanOrEqual(width + 1);
}
