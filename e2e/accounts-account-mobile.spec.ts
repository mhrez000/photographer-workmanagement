import type { Page } from "@playwright/test";
import { bogusToken } from "./api";
import { UI_TEST_TIMEOUT, expect, expectInsideViewportX, expectNoHorizontalOverflow, storageFor, test } from "./fixtures";

/**
 * My account's sign-in & security cards at phone width (390 × 844, touch): the Email card with its change form
 * open, the Password card, "Log out of other devices" and its confirm dialog, on Settings → My account (staff)
 * and the portal's Account page, plus the public /change-email page. Nothing scrolls sideways, every button is on
 * screen, and the text boxes are 16 px (no iOS zoom on focus). Uses people it invites, never a demo account.
 */

test.use({ role: "anon" });
test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

async function expectTouchSizedInputs(page: Page, scope: string): Promise<void> {
  const sizes = await page.locator(`${scope} input:not([type=hidden])`).evaluateAll((els) => els.filter((el) => (el as HTMLElement).offsetParent !== null).map((el) => parseFloat(getComputedStyle(el).fontSize)));
  expect(sizes.length, `${scope} has visible inputs`).toBeGreaterThan(0);
  for (const size of sizes) expect(size, `${scope} input font size`).toBeGreaterThanOrEqual(16);
}

async function checkSecurityCards(page: Page, path: "/settings/account" | "/portal/account"): Promise<void> {
  await page.goto(path);
  const email = page.locator("section#email");
  await expect(email.getByRole("heading", { name: "Email" })).toBeVisible({ timeout: 90_000 });
  await email.scrollIntoViewIfNeeded();
  await expectNoHorizontalOverflow(page, path);

  await email.getByRole("button", { name: "Change email" }).click();
  await expect(email.getByLabel("New email")).toBeVisible();
  await expectTouchSizedInputs(page, "section#email");
  for (const name of [/^cancel$/i, /change email|send confirmation link/i]) {
    await expectInsideViewportX(page, email.locator("form").getByRole("button", { name }), `${path} email form button ${name}`);
  }
  await expectNoHorizontalOverflow(page, `${path} (email form open)`);
  await email.getByRole("button", { name: /^cancel$/i }).click();

  const password = page.locator("section#password");
  await password.scrollIntoViewIfNeeded();
  await expectTouchSizedInputs(page, "section#password");
  await expectInsideViewportX(page, password.getByRole("button", { name: "Change password" }), `${path} change password button`);

  const devices = page.locator("section#devices");
  await devices.scrollIntoViewIfNeeded();
  const logOutOthers = devices.getByRole("button", { name: "Log out of other devices" });
  await expectInsideViewportX(page, logOutOthers, `${path} log out of other devices`);
  await logOutOthers.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Log out of other devices?")).toBeVisible();
  await expectInsideViewportX(page, dialog.getByRole("button", { name: "Log out of other devices" }), `${path} dialog confirm`);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expectNoHorizontalOverflow(page, `${path} (end)`);
}

test("phone: staff My account security cards fit at 390 px", async ({ api, pageWithState }) => {
  const editor = await api.inviteUser("editor", "Acct phone");
  const page = await pageWithState(await storageFor(editor.email, editor.tempPassword));
  await checkSecurityCards(page, "/settings/account");
});

test("phone: portal Account security cards fit at 390 px", async ({ api, pageWithState }) => {
  const { clientId } = await api.createClient("Acct phone portal", { portal: true });
  const client = await api.inviteUser("client", { label: "Acct phone portal", clientId });
  const page = await pageWithState(await storageFor(client.email, client.tempPassword));
  await checkSecurityCards(page, "/portal/account");
});

test("phone: /change-email fits, and its one button is on screen", async ({ page }) => {
  await page.goto(`/change-email?token=${bogusToken()}`);
  const button = page.getByRole("button", { name: "Confirm my new email" });
  await expect(button).toBeVisible({ timeout: 90_000 });
  await expectInsideViewportX(page, button, "confirm button");
  await expectNoHorizontalOverflow(page, "/change-email");
  await button.click();
  await expect(page.getByText("This email change link is no longer valid").first()).toBeVisible();
  await expectNoHorizontalOverflow(page, "/change-email (dead link)");
});
