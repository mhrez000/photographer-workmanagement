import type { Locator, Page } from "@playwright/test";
import { signUpStudio } from "./api";
import { UI_TEST_TIMEOUT, expect, expectInsideViewportX, expectNoHorizontalOverflow, publicForm, storageFor, test, waitForHydration } from "./fixtures";

/**
 * Accounts on a phone (390×844, touch — docs/ACCOUNTS.md §1, §7): sign in with and without the "Look around the demo"
 * panel, Create your studio (the honeypot never shows or widens the page; the Caps Lock line fits), the landing
 * page's header for a signed-in person, and the "You're signed in" notice. One column, nothing sideways, thumb-sized
 * buttons. The e2e studio is not a demo studio, so the panel checks run only where a server offers it.
 */

test.use({ role: "anon" });
test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

/** The design system's touch size for lg buttons and coarse-pointer fields. */
const MIN_TAP = 40;

async function expectThumbSized(locator: Locator, what: string): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, `${what} has a box`).not.toBeNull();
  expect(Math.round(box!.height), `${what} is ${box!.height}px tall`).toBeGreaterThanOrEqual(MIN_TAP);
}

async function pressWithCapsLock(field: Locator): Promise<void> {
  await field.focus();
  await field.evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "A", bubbles: true, modifierCapsLock: true })));
}

async function demoPanelOffered(page: Page): Promise<boolean> {
  await page.goto("/login?demo=1", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  return (await page.locator("[data-demo-panel]").count()) > 0;
}

test("sign in at 390px without the demo panel: the form fits, a ?demo=1 visitor gets a plain note that fits too", async ({ page }) => {
  expect(page.viewportSize()?.width).toBe(390);
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  const offered = (await page.locator("[data-demo-panel]").count()) > 0;
  test.skip(offered, "this server offers the demo panel; the next test covers that layout");
  const form = publicForm(page);
  for (const field of await form.locator("input:not([type=hidden])").all()) await expectInsideViewportX(page, field, "sign-in field");
  await expectNoHorizontalOverflow(page);

  await page.goto("/login?demo=1", { waitUntil: "domcontentloaded" });
  const note = page.getByText(/demo studio isn.t open right now/i);
  await expect(note).toBeVisible();
  await expectInsideViewportX(page, note, "the demo note");
  await expect(publicForm(page).locator('input[type="password"]')).toHaveCount(1);
  await expectNoHorizontalOverflow(page);
});

test("sign in at 390px WITH the demo panel: four thumb-sized persona buttons, first on ?demo=1, nothing sideways", async ({ page }) => {
  test.skip(!(await demoPanelOffered(page)), "this server has no demo studio (the e2e database is seeded with SEED_DEMO=off)");
  const panel = page.locator("[data-demo-panel]");
  await expect(panel).toHaveAttribute("data-highlighted", "");
  const buttons = panel.locator("[data-demo-persona]");
  await expect(buttons).toHaveCount(4);
  for (const button of await buttons.all()) {
    await expectInsideViewportX(page, button, "persona button");
    await expectThumbSized(button, "persona button");
  }
  // The panel comes before the sign-in form.
  const panelBox = await panel.boundingBox();
  const formBox = await publicForm(page).boundingBox();
  expect(panelBox!.y).toBeLessThan(formBox!.y);
  await expectNoHorizontalOverflow(page);
});

test("Create your studio at 390px: the honeypot never shows or widens the page; the invitee line and the Caps Lock line fit", async ({ page }) => {
  await page.goto("/signup", { waitUntil: "domcontentloaded" });
  await waitForHydration(page);
  await expectNoHorizontalOverflow(page);
  const trap = page.locator('[data-honeypot] input[name="website"]');
  await expect(trap).toHaveCount(1);
  const trapBox = await trap.boundingBox();
  expect(trapBox && trapBox.x + trapBox.width < 0, `honeypot box ${JSON.stringify(trapBox)}`).toBe(true);
  await expect(page.getByRole("textbox", { name: /website/i })).toHaveCount(0);
  // The form's own fields are the ones a person sees (the honeypot sits outside the <form>).
  await expect(publicForm(page).locator('input[name="website"]')).toHaveCount(0);

  const line = page.getByText("Editing for a studio, or a client? Use the invite link your studio sent you.");
  await expect(line).toBeVisible();
  await expectInsideViewportX(page, line, "the invitee line");

  const password = publicForm(page).locator('input[type="password"]');
  await pressWithCapsLock(password);
  const hint = page.locator("[data-caps-lock-hint]");
  await expect(hint).toHaveText(/caps lock is on/i);
  await expectInsideViewportX(page, hint, "the Caps Lock line");
  await expectNoHorizontalOverflow(page);
});

test.describe("signed in", () => {
  test.use({ role: "owner" });

  test("the landing page at 390px: one 'Go to your studio' button in the header, inside the screen", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/$/);
    const back = page.getByRole("banner").getByRole("link", { name: /go to your studio/i });
    await expect(back).toBeVisible();
    await expect(back).toHaveAttribute("href", "/home");
    await expectInsideViewportX(page, back, "Go to your studio");
    await expect(page.getByRole("banner").locator('a[href^="/login"], a[href^="/signup"]')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });
});

test("the signed-in notice at 390px: who you are, and two thumb-sized buttons that fit", async ({ pageWithState }) => {
  const studio = await signUpStudio("Mobile notice");
  const page = await pageWithState(await storageFor(studio.email, studio.password));
  try {
    for (const path of ["/login", "/signup"]) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      const notice = page.locator("[data-signed-in-notice]");
      await expect(notice, path).toContainText(studio.ownerName);
      const go = notice.getByRole("link", { name: /go to your studio/i });
      const out = notice.getByRole("button", { name: /^log out$/i });
      for (const [control, what] of [
        [go, "Go to your studio"],
        [out, "Log out"],
      ] as const) {
        await expect(control).toBeVisible();
        await expectInsideViewportX(page, control, `${path} ${what}`);
        await expectThumbSized(control, `${path} ${what}`);
      }
      await expectNoHorizontalOverflow(page);
    }
  } finally {
    await studio.api.dispose();
  }
});
