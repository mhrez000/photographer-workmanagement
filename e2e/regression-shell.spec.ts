import { uniq } from "./api";
import { UI_TEST_TIMEOUT, expect, expectInsideViewportX, expectNoHorizontalOverflow, gotoReady, retrying, test } from "./fixtures";

/**
 * Regressions (audit batch F, app shell): the Ctrl+K palette takes focus and
 * typing, filter popovers stay inside a 390px viewport, and the topbar names
 * the /notifications page.
 */
test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

test("Ctrl+K opens the command palette with the input focused, and typing searches", async ({ page, api }) => {
  const job = await api.createJob({ name: uniq("Reg palette") });
  const palette = page.getByRole("dialog", { name: "Command palette" });
  const input = palette.getByPlaceholder(/search jobs, clients, people/i);

  await gotoReady(page, "/dashboard", page.getByRole("region", { name: "Key numbers" }));
  await retrying(async () => {
    // Before hydration the shortcut is not wired yet: press until the palette opens.
    if (!(await palette.isVisible())) await page.keyboard.press("Control+k");
    await expect(palette).toBeVisible({ timeout: 2_000 });
    // The regression: the dialog opened but focus stayed on <body>.
    await expect(input).toBeFocused({ timeout: 2_000 });

    // Typing without clicking first lands in the input and searches.
    await input.clear();
    await page.keyboard.type(job.name);
    await expect(input).toHaveValue(job.name, { timeout: 2_000 });
    await expect(palette.getByRole("option", { name: new RegExp(job.jobNumber) }).first()).toBeVisible({ timeout: 15_000 });

    // Closing and reopening focuses the input again (not only on first mount).
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden({ timeout: 2_000 });
    await page.keyboard.press("Control+k");
    await expect(palette).toBeVisible({ timeout: 2_000 });
    await expect(input).toBeFocused({ timeout: 2_000 });
    await expect(input).toHaveValue("");
  });
});

test.describe("at 390px", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("filter popovers on All Work stay inside the viewport", async ({ page }) => {
    const bar = page.getByRole("search", { name: "Filter jobs" });
    await gotoReady(page, "/workspace/all", bar);

    for (const label of ["status", "editor", "photographer", "client", "job type", "priority"]) {
      const trigger = bar.getByRole("button", { name: `Filter by ${label}` });
      const popover = page.getByRole("dialog", { name: new RegExp(`^${label} filter$`, "i") });
      await retrying(async () => {
        // A pre-hydration tap is a no-op: tap until the popover is open.
        if (!(await popover.isVisible())) {
          await trigger.scrollIntoViewIfNeeded();
          await trigger.click();
        }
        await expect(popover, `${label} popover`).toBeVisible({ timeout: 2_000 });
      });
      // Let the viewport clamp / auto-flip effects settle, then measure.
      await expect.poll(async () => (await popover.boundingBox())?.x ?? -999).toBeGreaterThanOrEqual(-1);
      await expectInsideViewportX(page, popover, `${label} filter popover`);
      await expectNoHorizontalOverflow(page);
      await page.keyboard.press("Escape");
      await expect(popover).toBeHidden();
    }
  });
});

test("the topbar names the Notifications page", async ({ page }) => {
  const banner = page.getByRole("banner");
  await gotoReady(page, "/notifications", banner);
  // The topbar title — not the bell link's aria-label, not the generic "Proofline" fallback.
  await expect(banner.getByText("Notifications", { exact: true })).toBeVisible();
  await expect(banner.getByText("Proofline", { exact: true })).toHaveCount(0);
});
