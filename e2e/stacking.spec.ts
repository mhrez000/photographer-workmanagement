import type { Locator, Page } from "@playwright/test";
import { ROLE_EMAILS, uniq } from "./api";
import { UI_TEST_TIMEOUT, accountMenuButton, expect, gotoReady, jobHeading, mainNav, retrying, test } from "./fixtures";

/**
 * Stacking order (docs/ROLES.md §11.1): on a job page the topbar's account menu must open ABOVE the
 * page's sticky parts (the job header and the pinned Next step card on phones). One global z scale:
 * page-sticky 20 < shell 30 < topbar 40 < popover 50 < toast 100, and no page element may reach the
 * topbar's level.
 *
 * Each check uses `document.elementFromPoint` at the centre of every item: the element actually
 * painted there must belong to the menu / tooltip / drawer.
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

async function expectOnTop(page: Page, container: Locator, items: Locator, what: string): Promise<void> {
  const count = await items.count();
  expect(count, `${what}: no items`).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    const item = items.nth(i);
    const box = await item.boundingBox();
    expect(box, `${what} item ${i} has no box`).not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    const hit = await container.evaluate(
      (el, [px, py]) => {
        const top = document.elementFromPoint(px, py);
        return { inside: Boolean(top && el.contains(top)), top: top ? top.outerHTML.slice(0, 160) : null };
      },
      [x, y] as const,
    );
    expect(hit.inside, `${what} item ${i} (${(await item.innerText()).trim()}) is covered by: ${hit.top}`).toBe(true);
  }
}

async function scrollPage(page: Page, dy: number): Promise<void> {
  await page.mouse.move(700, 600);
  await page.mouse.wheel(0, dy);
  await page.evaluate((d) => {
    window.scrollBy(0, d);
    const main = document.querySelector("main");
    for (let el: HTMLElement | null = main; el; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY.match(/auto|scroll/)) {
        el.scrollTop += d;
        break;
      }
    }
  }, dy);
}

/** A job with an editor and enough messages that the page scrolls. */
async function busyJob(api: import("./api").Api) {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const job = await api.createJob({ name: uniq("Stacking"), editorId: editor.id });
  for (let i = 0; i < 8; i += 1) await api.addComment(job.id, `E2E stacking message ${i} — padding the page so the header sticks.`);
  return job;
}

async function openAccountMenu(page: Page): Promise<Locator> {
  const menu = page.getByRole("menu", { name: "Account" });
  await retrying(async () => {
    if (!(await menu.isVisible())) await accountMenuButton(page).click({ timeout: 5_000 });
    await expect(menu).toBeVisible({ timeout: 3_000 });
  });
  return menu;
}

/** No element inside <main> may sit at or above the topbar's layer. */
async function expectNothingInMainAtTopbarLevel(page: Page, where: string): Promise<void> {
  const offenders = await page.evaluate(() => {
    const topbar = Array.from(document.querySelectorAll("header")).find((h) => !h.closest("main, article, aside, nav, section")) ?? null;
    const topZ = topbar ? Number(getComputedStyle(topbar).zIndex) || 0 : 0;
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll("main *"))) {
      const cs = getComputedStyle(el);
      if (cs.position === "static") continue;
      if (el.closest('[role="menu"], [role="tooltip"], [role="dialog"], [role="listbox"], dialog')) continue;
      const z = Number(cs.zIndex);
      if (Number.isFinite(z) && z >= topZ) out.push(`${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).slice(0, 80)} z=${z}`);
    }
    return { topZ, out };
  });
  expect(offenders.topZ, "topbar z-index").toBe(40);
  expect(offenders.out, `${where}: page elements at or above the topbar`).toEqual([]);
}

test.describe("at 1280×800", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the topbar account menu opens above the job page and every item is clickable", async ({ page, api }) => {
    const job = await busyJob(api);
    await gotoReady(page, `/jobs/${job.id}`, jobHeading(page));
    await scrollPage(page, 700);
    const banner = page.getByRole("banner");
    expect(await banner.evaluate((el) => Number(getComputedStyle(el).zIndex))).toBe(40);
    await expectNothingInMainAtTopbarLevel(page, `/jobs/${job.id}`);

    const menu = await openAccountMenu(page);
    await expectOnTop(page, menu, menu.getByRole("menuitem"), "account menu");
    await menu.getByRole("menuitem", { name: "My account" }).click();
    await expect(page).toHaveURL(/\/settings\/account/);
  });

  test("the job page's ⋯ menu is not covered by the topbar when scrolled", async ({ page, api }) => {
    const job = await busyJob(api);
    await gotoReady(page, `/jobs/${job.id}`, jobHeading(page));
    await scrollPage(page, 700);
    const trigger = page.getByRole("main").getByRole("button", { name: /^(More actions|More)$/ }).first();
    const menu = page.getByRole("menu").first();
    await retrying(async () => {
      if (!(await menu.isVisible())) await trigger.click({ timeout: 5_000 });
      await expect(menu).toBeVisible({ timeout: 3_000 });
    });
    await expectOnTop(page, menu, menu.getByRole("menuitem"), "job ⋯ menu");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });

  test("the collapsed rail's tooltip paints above the topbar and the page", async ({ page }) => {
    await gotoReady(page, "/home", mainNav(page));
    const collapse = page.getByRole("button", { name: "Collapse sidebar" });
    await retrying(async () => {
      if (await collapse.isVisible()) await collapse.click({ timeout: 5_000 });
      await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible({ timeout: 3_000 });
    });
    const firstItem = mainNav(page).getByRole("link").first();
    const tooltip = page.getByRole("tooltip").filter({ visible: true });
    await retrying(async () => {
      await page.mouse.move(0, 0);
      await firstItem.hover({ timeout: 5_000 });
      await expect(tooltip).toHaveCount(1, { timeout: 3_000 });
    });
    expect(await tooltip.evaluate((el) => el.parentElement === document.body)).toBe(true);
    await tooltip.evaluate((el) => {
      (el as HTMLElement).style.pointerEvents = "auto";
    });
    await expectOnTop(page, tooltip, tooltip, "rail tooltip");
    // Restore the rail (force: the `next dev` overlay portal sometimes sits over the corner).
    await page.getByRole("button", { name: "Expand sidebar" }).click({ force: true });
  });
});

test.describe("at 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the account menu opens above the job page and its pinned next step", async ({ page, api }) => {
    const job = await busyJob(api);
    await gotoReady(page, `/jobs/${job.id}`, jobHeading(page));
    await scrollPage(page, 500);
    await expectNothingInMainAtTopbarLevel(page, `/jobs/${job.id} @390`);
    const menu = await openAccountMenu(page);
    await expectOnTop(page, menu, menu.getByRole("menuitem"), "account menu @390");
    await menu.getByRole("menuitem", { name: "My account" }).tap();
    await expect(page).toHaveURL(/\/settings\/account/);
  });

  test("the More drawer is the top layer: its first link is the hit target", async ({ page, api }) => {
    const job = await busyJob(api);
    await gotoReady(page, `/jobs/${job.id}`, jobHeading(page));
    // Phones: the tab bar's More tab replaces the topbar hamburger (UX-09); the drawer is titled "More".
    const bar = page.getByRole("navigation", { name: "Primary" });
    const more = bar.getByRole("button", { name: "More" });
    await expect(page.getByRole("banner").getByRole("button", { name: /open navigation/i })).toHaveCount(0);
    const drawer = page.getByRole("dialog", { name: "More" });
    await expect(more).toHaveAttribute("aria-expanded", "false");
    // Open it ONCE: while the sheet is open it covers the tab bar, so a second click would land on the backdrop and close it.
    await more.click();
    await expect(drawer).toBeVisible({ timeout: 5_000 });
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect.poll(async () => Math.round((await drawer.boundingBox())?.x ?? -999)).toBeGreaterThanOrEqual(0);
    const firstLink = drawer.getByRole("link").first();
    await expectOnTop(page, firstLink, firstLink, "drawer first link");
  });
});
