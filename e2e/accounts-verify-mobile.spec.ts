import type { Locator } from "@playwright/test";
import { localPath, signUpStudio, type Api } from "./api";
import { UI_TEST_TIMEOUT, expect, expectInsideViewportX, expectNoHorizontalOverflow, storageFor, test } from "./fixtures";

/**
 * "Confirm your email" on a phone (390×844, touch; AREA verify): the link page is one column, nothing scrolls
 * sideways, the one button is inside the screen and thumb-sized, and every outcome (confirmed, already used, broken
 * link, replaced + "Send a new link" with the dev-only link) fits. Runs in the `mobile` project only (file name ends in
 * `mobile.spec.ts`).
 */

test.use({ role: "anon" });
test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

/** `pointer-coarse:h-10` — the design system's touch size for buttons. */
const MIN_TAP = 40;

async function expectThumbSized(locator: Locator, what: string): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, `${what} has a box`).not.toBeNull();
  expect(Math.round(box!.height), `${what} is ${box!.height}px tall; thumbs need ${MIN_TAP}px`).toBeGreaterThanOrEqual(MIN_TAP);
}

/** "Send again" through the API; the dev server has no email, so the link comes back. */
async function devLink(api: Api): Promise<string> {
  const res = await api.raw<{ devLink?: string }>("POST", "/api/auth/email-verification/resend");
  expect(res.status).toBe(200);
  expect(res.data.devLink).toBeTruthy();
  return res.data.devLink!;
}

test("the link page fits a phone in every state", async ({ page, pageWithState }) => {
  const studio = await signUpStudio("Verify phone");
  try {
    test.skip((await studio.api.emailSettings()).configured, "email is configured on this server: confirm links are emailed, not shown");
    const first = await devLink(studio.api);
    await devLink(studio.api); // replaces the first

    // Signed in, a replaced link: "Send a new link" and the dev-only link both fit.
    const owner = await pageWithState(await storageFor(studio.email, studio.password));
    await owner.goto(localPath(first));
    const confirmOwner = owner.getByRole("button", { name: "Confirm my email" });
    await expect(confirmOwner).toBeVisible();
    await confirmOwner.click();
    await expect(owner.getByRole("heading", { name: "This link has been replaced" })).toBeVisible();
    const sendNew = owner.getByRole("button", { name: "Send a new link" });
    await expectInsideViewportX(owner, sendNew, "Send a new link");
    await expectThumbSized(sendNew, "Send a new link");
    await sendNew.click();
    await expect(owner.locator('section[aria-labelledby="dev-only-link"]')).toBeVisible();
    await expectNoHorizontalOverflow(owner, "the replaced-link state with the dev-only link");
    const newest = await owner.locator("section[aria-labelledby='dev-only-link'] a[href*='/verify-email?token=']").getAttribute("href");
    expect(newest).toBeTruthy();

    // Signed out: ready → confirmed → already used, one column, nothing sideways.
    await page.goto(localPath(newest!));
    await expect(page.getByRole("heading", { level: 1, name: "Confirm your email" })).toBeVisible();
    const confirm = page.getByRole("button", { name: "Confirm my email" });
    await expectInsideViewportX(page, confirm, "Confirm my email");
    await expectThumbSized(confirm, "Confirm my email");
    await expectNoHorizontalOverflow(page, "the ready state");
    await confirm.click();
    await expect(page.getByRole("heading", { name: "Email confirmed" })).toBeVisible();
    // Signed out: the next step is "Sign in" (UX-20).
    const cont = page.getByRole("link", { name: "Sign in" });
    await expectInsideViewportX(page, cont, "Sign in");
    await expectThumbSized(cont, "Sign in");
    await expectNoHorizontalOverflow(page, "the confirmed state");

    await page.goto(localPath(newest!));
    await page.getByRole("button", { name: "Confirm my email" }).click();
    await expect(page.getByRole("heading", { name: "This link has already been used" })).toBeVisible();
    await expectNoHorizontalOverflow(page, "the already-used state");

    await page.goto("/verify-email?token=abc");
    await expect(page.getByRole("heading", { name: "This link didn’t work" })).toBeVisible();
    await expectInsideViewportX(page, page.getByRole("link", { name: "Go to sign in" }), "Go to sign in");
    await expectNoHorizontalOverflow(page, "the dead-link card");
  } finally {
    await studio.api.dispose();
  }
});
