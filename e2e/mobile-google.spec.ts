import { UI_TEST_TIMEOUT, expect, expectInsideViewportX, expectNoHorizontalOverflow, test } from "./fixtures";

/**
 * "Continue with Google" screens on a phone (390×844, touch) on a server WITHOUT Google configured: the
 * /signup/google "start again" card and the "isn't available right now" note on sign-in fit the screen — nothing
 * scrolls sideways and the one button is thumb-sized.
 */

test.use({ role: "anon" });
test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

/** `pointer-coarse:h-10` — the design system's touch size for buttons. */
const MIN_TAP = 40;

test("/signup/google 'start again' at 390px: one column, the button on screen and thumb-sized", async ({ page }) => {
  expect(page.viewportSize()?.width).toBe(390);
  await page.goto("/signup/google?from=signin", { waitUntil: "domcontentloaded" });
  const card = page.locator("[data-google-start-again]");
  await expect(card).toBeVisible();
  await expectNoHorizontalOverflow(page);
  // "Start again" where Google sign-in is on; "Create your studio" where it is off (this server, UX-15).
  const button = card.getByRole("link", { name: /^(Start again|Create your studio)$/ });
  await expect(button).toBeVisible();
  await expectInsideViewportX(page, button, "the way forward");
  const box = await button.boundingBox();
  expect(Math.round(box?.height ?? 0)).toBeGreaterThanOrEqual(MIN_TAP);
});

test("sign-in with ?google=disabled at 390px: the note wraps inside the screen", async ({ page }) => {
  await page.goto("/login?google=disabled", { waitUntil: "domcontentloaded" });
  const note = page.locator('[data-google-result="disabled"]');
  await expect(note).toBeVisible();
  await expectInsideViewportX(page, note, "Google note");
  await expectNoHorizontalOverflow(page);
});
