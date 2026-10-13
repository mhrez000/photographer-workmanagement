/**
 * The e2e fixtures module: persona-based fixtures + shared UI helpers for the
 * simplified product (docs/SIMPLIFICATION-PLAN.md).
 *
 * - Each seeded account (`Role` in ./api: owner, the extra photographer, the
 *   three editors, the portal client, the other studio) logs in ONCE per worker
 *   through the REST API (`POST /api/auth/login` with an Origin header) and its
 *   storage state is saved to `e2e/.auth/<role>.<pid>.json` (gitignored).
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

/** Copy of the in-shell 403 page (`(app)/forbidden.tsx`) and the job 404 page. */
export const FORBIDDEN_TEXT = "You don't have access to this";
export const JOB_NOT_FOUND_TEXT = "We can't find that job";

/* ------------------------------ shell helpers ------------------------------ */

/** The desktop sidebar navigation (`<nav aria-label="Main">`). */
export function mainNav(page: Page) {
  return page.getByRole("navigation", { name: "Main" });
}

/** The phone bottom tab bar (`<nav aria-label="Primary">`). */
export function tabBar(page: Page) {
  return page.getByRole("navigation", { name: "Primary" });
}

/** Visible labels of the main navigation items, in order. */
export async function mainNavLabels(page: Page): Promise<string[]> {
  const links = mainNav(page).getByRole("link");
  const texts = await links.allInnerTexts();
  return texts.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** The topbar account-menu trigger (`Account menu for <name>`). */
export function accountMenuButton(page: Page) {
  return page.getByRole("banner").getByRole("button", { name: /^Account menu for / });
}

/* ------------------------------ job page helpers ------------------------------ */

/** Opens a job page and waits for its heading. */
export async function openJob(page: Page, jobId: string): Promise<void> {
  await page.goto(`/jobs/${jobId}`);
  await expect(jobHeading(page)).toBeVisible();
}

/** The job page heading (address / job name); the topbar has its own h1 outside <main>. */
export function jobHeading(page: Page) {
  return page.getByRole("main").getByRole("heading", { level: 1 }).first();
}

/**
 * The "Next step" card at the top of the job page (plan §5): `<section aria-label="Next step">`.
 * The page renders one for laptops and a pinned one for phones; role queries skip the hidden one.
 */
export function nextStepCard(page: Page) {
  return page.getByRole("main").getByRole("region", { name: "Next step" }).first();
}

/** The stage pill (`<span data-stage>` from StagePill) in the job header. */
export function stagePill(page: Page, stage?: string) {
  return page.getByRole("main").locator(stage ? `span[data-stage="${stage}"]` : "span[data-stage]").first();
}

/** The "Waiting on: <name>" line of the job header (the wrapper of the "Waiting on:" label). */
export function waitingOn(page: Page) {
  return page.getByRole("main").locator('span:has(> span:text-is("Waiting on:"))').first();
}

/** The "Who did what" card (plan §5 section 7): a SectionCard = `<section aria-labelledby>`. */
export function whoDidWhat(page: Page) {
  return sectionNamed(page, /^who did what/i);
}

/** The ⋯ menu trigger on the job page. */
export function moreActions(page: Page) {
  return page.getByRole("main").getByRole("button", { name: /^(More actions|More)$/ }).first();
}

/**
 * A section of the simplified job page / Home / My jobs by its heading. SectionCards are
 * `<section aria-labelledby>`, My jobs sections `<section aria-label>` (both = region); collapsed
 * sections are `<details>` whose summary holds the heading.
 */
export function sectionNamed(page: Page, name: RegExp | string) {
  const main = page.getByRole("main");
  // A SectionCard without an `id` has no aria-labelledby: fall back to the nearest <section> / <details> around the heading.
  const byHeading = main.getByRole("heading", { name }).locator("xpath=ancestor::*[self::section or self::details][1]");
  return main.getByRole("region", { name }).or(byHeading).first();
}

/** A visible job card / row labelled by the job name (list item, article or table row containing it). */
export function jobCard(page: Page, jobName: string) {
  const re = new RegExp(escapeRegExp(jobName));
  const main = page.getByRole("main");
  return main.getByRole("listitem").filter({ hasText: re }).or(main.getByRole("article", { name: re })).or(main.getByRole("row").filter({ hasText: re })).first();
}

/** The main button inside a dialog (the one whose name matches). */
export function dialogButton(page: Page, name: RegExp | string) {
  return page.getByRole("dialog").getByRole("button", { name }).first();
}

/**
 * Picks `name` in a person / client picker: a native <select>, a radio or option list (the Assign
 * editor dialog), or the form Combobox (a button trigger opening a popover with a search box and a
 * listbox).
 */
export async function pickPerson(page: Page, scope: Locator, name: string): Promise<void> {
  const re = new RegExp(escapeRegExp(name));
  const select = scope.locator("select");
  if ((await select.count()) > 0) {
    const options = await select.first().locator("option").allInnerTexts();
    const hit = options.find((o) => re.test(o));
    if (!hit) throw new Error(`no option matching ${name} in ${options.join(", ")}`);
    await select.first().selectOption({ label: hit });
    return;
  }
  const direct = scope.getByRole("radio", { name: re }).or(scope.getByRole("option", { name: re }));
  if ((await direct.count()) > 0) {
    await direct.first().click();
    return;
  }
  const trigger = scope.getByRole("combobox").or(scope.locator('button[aria-haspopup="dialog"]')).or(scope.getByRole("button")).first();
  await trigger.click();
  const search = page.locator('input[aria-autocomplete="list"]').or(page.getByRole("dialog").getByRole("textbox"));
  if ((await search.count()) > 0) await search.first().fill(name);
  await page.getByRole("option", { name: re }).first().click();
}

/**
 * Assign / Change editor through the dialog (plan §5): press `trigger` (Assign editor / Change
 * editor), pick the editor in "Who should edit this?" / "Change editor", confirm. Retries until the
 * job reaches `category` (a pre-hydration press is a silent no-op in `next dev`).
 */
export async function assignEditorViaDialog(page: Page, trigger: Locator, editorName: string, api: Api, jobId: string, category: string | readonly string[]): Promise<void> {
  const wanted = typeof category === "string" ? [category] : [...category];
  const dialog = page.getByRole("dialog");
  await retrying(async () => {
    const job = (await api.job(jobId)).job;
    if (wanted.includes(job.statusCategory) && job.editor?.name === editorName) return;
    const reload = dialog.getByRole("button", { name: /reload latest/i });
    if (await reload.isVisible().catch(() => false)) await reload.click();
    if (!(await dialog.isVisible().catch(() => false))) await trigger.first().click({ timeout: 5_000 });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog).toContainText(/On their desk/, { timeout: 10_000 });
    await dialog.getByRole("radio", { name: new RegExp(escapeRegExp(editorName)) }).first().click({ timeout: 5_000 });
    await dialog.getByRole("button", { name: /^(assign|change) editor$/i }).click({ timeout: 5_000 });
    await expect.poll(async () => (await api.job(jobId)).job.editor?.name ?? null, { timeout: 10_000 }).toBe(editorName);
  }, 90_000);
}

/**
 * Opens a searchable combobox (button trigger → popover with a search input and
 * a listbox), types `text` and picks the first option containing it.
 */
export async function pickFromCombobox(page: Page, trigger: Locator, text: string): Promise<void> {
  await expect(trigger).toBeEnabled();
  await trigger.click();
  const search = page.getByRole("combobox").and(page.locator('input[aria-autocomplete="list"]'));
  if ((await search.count()) > 0) await search.first().fill(text);
  await page.getByRole("option", { name: text }).first().click();
}

/** Fills a form field found by its label whether it is a textbox, a textarea or a native select. */
export async function fillField(scope: Locator, label: RegExp | string, value: string): Promise<void> {
  const box = scope.getByRole("textbox", { name: label }).or(scope.getByLabel(label)).first();
  const tag = await box.evaluate((el) => el.tagName.toLowerCase());
  if (tag === "select") await box.selectOption({ label: value });
  else await box.fill(value);
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

/**
 * Clicks `button` until the job reaches `category` (a pre-hydration click is a
 * silent no-op in `next dev`; a stale page shows the conflict dialog, which
 * the retry reloads through "Reload latest").
 */
export async function clickUntilCategory(page: Page, button: Locator, api: Api, jobId: string, category: string | readonly string[], timeout = 90_000): Promise<void> {
  const wanted = typeof category === "string" ? [category] : [...category];
  await retrying(async () => {
    const current = (await api.job(jobId)).job.statusCategory;
    if (wanted.includes(current)) return;
    const reload = page.getByRole("dialog").getByRole("button", { name: /reload latest/i });
    if (await reload.isVisible().catch(() => false)) await reload.click();
    await button.first().click({ timeout: 5_000 });
    await expect.poll(async () => (await api.job(jobId)).job.statusCategory, { timeout: 8_000 }).toMatch(new RegExp(`^(${wanted.join("|")})$`));
  }, timeout);
}

/* ---------------------------- layout checks ---------------------------- */

/** The document never scrolls sideways (the shell's own scrollers may). */
export async function expectNoHorizontalOverflow(page: Page, where = new URL(page.url()).pathname + new URL(page.url()).search): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${where} is ${scrollWidth}px wide in a ${clientWidth}px viewport`).toBeLessThanOrEqual(clientWidth);
}

/** The element's box lies inside the viewport horizontally (1px tolerance for subpixel rounding). */
export async function expectInsideViewportX(page: Page, locator: Locator, what: string): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, `${what} has no box`).not.toBeNull();
  const width = page.viewportSize()?.width ?? 0;
  expect(box!.x, `${what} starts left of the viewport`).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width, `${what} ends past the ${width}px viewport`).toBeLessThanOrEqual(width + 1);
}

/** The element's box lies inside the viewport vertically (it is on screen without scrolling). */
export async function expectInsideViewportY(page: Page, locator: Locator, what: string): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, `${what} has no box`).not.toBeNull();
  const height = page.viewportSize()?.height ?? 0;
  expect(box!.y, `${what} starts above the viewport`).toBeGreaterThanOrEqual(-1);
  expect(box!.y + box!.height, `${what} ends below the ${height}px viewport`).toBeLessThanOrEqual(height + 1);
}

/**
 * The simplified UI never uses these words (plan §7 "Dropped words", §1): the
 * page's visible text is checked after every screen renders.
 */
export const DROPPED_WORDS = /\b(turnaround|utilisation|utilization|capacity hours|workload band|bottleneck|throughput|headroom|revision rate|completion rate)\b/i;

export async function expectPlainWords(page: Page, where: string): Promise<void> {
  const text = await page.getByRole("main").innerText();
  const hit = text.match(DROPPED_WORDS);
  expect(hit, `${where} uses a dropped word: ${hit?.[0]}`).toBeNull();
}
