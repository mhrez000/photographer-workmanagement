import type { Locator, Page } from "@playwright/test";
import { bogusToken, localPath } from "./api";
import { UI_TEST_TIMEOUT, emailBox, expect, expectInsideViewportX, expectInsideViewportY, expectNoHorizontalOverflow, publicForm, submitButton, test } from "./fixtures";

/**
 * The front door on a phone (390×844, touch): the landing page, Create your studio, an invite link,
 * Sign in, Forgot and Reset. One column, nothing scrolls sideways, every field and the one button are
 * inside the viewport and big enough for a thumb (the design system's coarse-pointer size: 40 px, see
 * `pointer-coarse:h-10` in components/ui/button.tsx and input.tsx).
 */

test.use({ role: "anon" });
test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

/** `pointer-coarse:h-10` — the design system's touch size for buttons and text boxes. */
const MIN_TAP = 40;
/** iOS Safari zooms the page when a focused text box is smaller than 16 px. */
const NO_ZOOM_FONT_PX = 16;

const PUBLIC_FORMS: readonly [url: string, heading: RegExp][] = [
  ["/signup", /create your studio/i],
  ["/login", /sign in/i],
  ["/forgot-password", /forgot your password/i],
  [`/reset-password?token=${bogusToken()}`, /choose a new password/i],
];

async function expectThumbSized(locator: Locator, what: string): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, `${what} has a box`).not.toBeNull();
  expect(Math.round(box!.height), `${what} is ${box!.height}px tall; thumbs need ${MIN_TAP}px`).toBeGreaterThanOrEqual(MIN_TAP);
}

/** Every text box of a public form is inside the viewport and thumb-sized; so is the one button. */
async function expectFormFitsPhone(page: Page, form: Locator, where: string): Promise<void> {
  await expect(form).toBeVisible();
  const inputs = form.locator("input:not([type=hidden])");
  const n = await inputs.count();
  expect(n, `${where} has fields`).toBeGreaterThan(0);
  for (let i = 0; i < n; i += 1) {
    const input = inputs.nth(i);
    await expectInsideViewportX(page, input, `${where} field ${i + 1}`);
    await expectThumbSized(input, `${where} field ${i + 1}`);
  }
  const submit = submitButton(form);
  await expect(submit).toBeVisible();
  await expectInsideViewportX(page, submit, `${where} button`);
  await expectThumbSized(submit, `${where} button`);
  // The form fills the phone's width (one column, no desktop brand panel squeezing it).
  const box = await form.boundingBox();
  expect(box!.width, `${where} form width`).toBeGreaterThan(300);
  await expectNoHorizontalOverflow(page);
}

test("landing at 390px: headline and the two ways in on screen, thumb-sized, nothing sideways", async ({ page }) => {
  expect(page.viewportSize()?.width).toBe(390);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  const start = page.getByRole("main").locator('a[href^="/signup"]').first();
  await expect(start).toBeVisible();
  await expectInsideViewportX(page, start, "Create your studio");
  await expectInsideViewportY(page, start, "Create your studio (above the fold)");
  await expectThumbSized(start, "Create your studio");
  const signIn = page.getByRole("main").locator('a[href^="/login"]').first();
  await expect(signIn).toBeVisible();
  await expectInsideViewportX(page, signIn, "Sign in");
  await expectThumbSized(signIn, "Sign in");
  // The header's Sign in is reachable too, and the page stays one column all the way down.
  await expect(page.getByRole("banner").locator('a[href^="/login"]').first()).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expectNoHorizontalOverflow(page);
  await expect(page.locator('a[href^="/signup"]').last()).toBeVisible();
  // No staff shell, no phone tab bar on a public page.
  await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
});

test("Create your studio at 390px: one column, fields and the button fit", async ({ page }) => {
  await page.goto("/signup", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/create your studio/i);
  const form = publicForm(page);
  await expectFormFitsPhone(page, form, "/signup");
  await expect(emailBox(form)).toBeVisible();
  await expect(form.locator('input[type="password"]')).toHaveCount(1);
});

test("an invite link at 390px: who invited you, one password step, the button in reach", async ({ page, api }) => {
  const invite = await api.inviteByLink("editor", "Mobile invite");
  const studio = (await api.settings()).organisation.name;
  await page.goto(localPath(invite.inviteUrl), { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1 })).toContainText(studio);
  const form = publicForm(page);
  await expectFormFitsPhone(page, form, "/invite");
  await expect(form.locator('input[type="password"]')).toHaveCount(1);
  await expect(form.getByRole("textbox", { name: /^email/i })).toHaveValue(invite.email);
  // Cleanup: the link stays live until the owner revokes it (nothing else to undo).
  await api.revokeInvite(invite.user.id);
});

test("Sign in, Forgot and Reset at 390px fit too", async ({ page }) => {
  for (const [url, heading] of PUBLIC_FORMS.slice(1)) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 }), url).toContainText(heading);
    await expectFormFitsPhone(page, publicForm(page), url);
  }
});

/**
 * The design system gives text boxes 16 px on coarse pointers and phone widths (`pointer-coarse:text-touch
 * max-sm:text-touch` in components/ui/input.tsx, select.tsx, textarea.tsx), so iOS Safari does not zoom the
 * page when a field is focused.
 */
test("text boxes on the public forms are 16px on a phone, so iOS does not zoom on focus", async ({ page }) => {
  for (const [url] of PUBLIC_FORMS) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const inputs = publicForm(page).locator("input:not([type=hidden])");
    const n = await inputs.count();
    for (let i = 0; i < n; i += 1) {
      const fontSize = await inputs.nth(i).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(fontSize, `${url} field ${i + 1} font-size ${fontSize}px`).toBeGreaterThanOrEqual(NO_ZOOM_FONT_PX);
    }
  }
});
