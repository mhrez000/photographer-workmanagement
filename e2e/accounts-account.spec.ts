import type { Page } from "@playwright/test";
import { bogusToken, fieldErrorsOf, loginApi, newApi, uniqPassword, type Api, type InvitedUser } from "./api";
import { UI_TEST_TIMEOUT, expect, sessionCookie, storageFor, test } from "./fixtures";

/**
 * Settings → My account / portal Account — sign-in & security (docs/ACCOUNTS.md "My account"; AREA account of
 * docs/ACCOUNTS-PLAN.md): change your email (no email provider on the dev server → it changes at once and the new
 * address signs in), change your password (this browser stays signed in, others are logged out), "Log out of other
 * devices" (a second browser is logged out, this one stays), and the public /change-email page (confirms on a button
 * press only; a dead link says so plainly). Every test uses people it invites — never a seeded demo account.
 */

test.use({ role: "anon" });
test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function emailCard(page: Page) {
  return page.locator("section#email");
}

async function skipWhenEmailConfigured(api: Api): Promise<void> {
  const email = await api.emailSettings();
  test.skip(email.configured, "email is configured on this server: an email change waits for the link instead of applying at once");
}

/** Opens My account (staff or portal) as `page` and waits for the Email card to be interactive. */
async function openAccount(page: Page, path: "/settings/account" | "/portal/account"): Promise<void> {
  await page.goto(path);
  await expect(emailCard(page).getByRole("heading", { name: "Email" })).toBeVisible({ timeout: 90_000 });
}

/** "Change email" → fill the form → submit; the form stays open on a refusal. */
async function submitEmailChange(page: Page, newEmail: string, password: string): Promise<void> {
  const card = emailCard(page);
  const opener = card.getByRole("button", { name: /^(change email|use a different email)$/i });
  if (await opener.isVisible().catch(() => false)) await opener.click();
  await card.getByLabel("New email").fill(newEmail);
  await card.getByLabel("Current password", { exact: true }).fill(password);
  await card.locator("form").getByRole("button", { name: /change email|send confirmation link/i }).click();
}

async function expectSignInWorks(email: string, password: string): Promise<void> {
  const session = await loginApi(email, password);
  await session.dispose();
}

async function expectSignInRefused(email: string, password: string): Promise<void> {
  const anon = await newApi();
  try {
    expect((await anon.raw("POST", "/api/auth/login", { email, password })).status).toBe(401);
  } finally {
    await anon.dispose();
  }
}

test("staff: change your email on My account — refusals first, then it changes and the new address signs in", async ({ api, pageWithState }) => {
  await skipWhenEmailConfigured(api);
  const editor: InvitedUser = await api.inviteUser("editor", "Acct email");
  const page = await pageWithState(await storageFor(editor.email, editor.tempPassword));
  await openAccount(page, "/settings/account");
  const card = emailCard(page);
  await expect(card.locator("[data-account-email]")).toHaveText(editor.email);

  // Wrong password: said on the password field, nothing changes.
  const newEmail = `e2e-moved-${stamp()}@example.test`;
  await submitEmailChange(page, newEmail, "definitely-not-it-1");
  await expect(card.getByText("That password isn’t right")).toBeVisible();
  // UX-09: the cursor is back on the field with the problem (not lost on the page).
  await expect(card.locator('input[aria-invalid="true"]').first()).toBeFocused();

  // An address someone already uses (the studio owner's): said on the email field.
  await submitEmailChange(page, "owner@studio.test", editor.tempPassword);
  await expect(card.getByText("That email is already in use")).toBeVisible();
  await expect(card.locator('input[aria-invalid="true"]').first()).toBeFocused();

  // The real change: applies at once on a server without email.
  await submitEmailChange(page, newEmail.toUpperCase(), editor.tempPassword);
  await expect(page.getByText("Email changed").first()).toBeVisible();
  await expect(card.locator("[data-account-email]")).toHaveText(newEmail);
  await expect(card.locator("form")).toHaveCount(0);

  await expectSignInWorks(newEmail, editor.tempPassword);
  await expectSignInRefused(editor.email, editor.tempPassword);
  // The owner sees the new address on the person (and History records it).
  expect((await api.get<{ profile: { email: string } }>(`/api/users/${editor.user.id}`)).profile.email).toBe(newEmail);
  // This browser is still signed in.
  expect(await sessionCookie(page)).toBeTruthy();
  await page.reload();
  await expect(card.locator("[data-account-email]")).toHaveText(newEmail);
});

test("staff: change your password — this browser stays signed in, another browser is logged out, the new password works", async ({ api, pageWithState }) => {
  const photographer = await api.inviteUser("photographer", { label: "Acct password", preset: "own_shoots" });
  const page = await pageWithState(await storageFor(photographer.email, photographer.tempPassword));
  const otherDevice = await loginApi(photographer.email, photographer.tempPassword);
  try {
    await openAccount(page, "/settings/account");
    const card = page.locator("section#password");
    await expect(card.getByRole("heading", { name: "Password" })).toBeVisible();
    await expect(card.getByText(/logs you out everywhere else/i)).toBeVisible();

    // Wrong current password → said on that field.
    const next = uniqPassword();
    await card.getByLabel("Current password", { exact: true }).fill("not-the-password-1");
    await card.getByLabel("New password", { exact: true }).fill(next);
    await card.getByLabel("Type it again", { exact: true }).fill(next);
    await card.getByRole("button", { name: "Change password" }).click();
    // UX-10: one sentence for a wrong password, and the cursor is back on that field (UX-09).
    await expect(card.getByText("That password isn’t right")).toBeVisible();
    await expect(card.getByLabel("Current password", { exact: true })).toBeFocused();

    await card.getByLabel("Current password", { exact: true }).fill(photographer.tempPassword);
    await card.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Password changed").first()).toBeVisible();

    expect((await otherDevice.raw("GET", "/api/auth/me")).status).toBe(401);
    await page.reload();
    await expect(card.getByRole("heading", { name: "Password" })).toBeVisible();
    await expectSignInWorks(photographer.email, next);
    await expectSignInRefused(photographer.email, photographer.tempPassword);
  } finally {
    await otherDevice.dispose();
  }
});

test("staff: Log out of other devices — the other browser is logged out, this one stays", async ({ api, pageWithState }) => {
  const editor = await api.inviteUser("editor", "Acct devices");
  const here = await pageWithState(await storageFor(editor.email, editor.tempPassword));
  const there = await pageWithState(await storageFor(editor.email, editor.tempPassword));
  await there.goto("/my-jobs");
  await expect(there).toHaveURL(/\/my-jobs/);

  await openAccount(here, "/settings/account");
  const card = here.locator("section#devices");
  // UX-03: the card also says what the menu's "Log out" does.
  await expect(card).toContainText("“Log out” in the menu logs you out everywhere, this device included.");
  await card.getByRole("button", { name: "Log out of other devices" }).click();
  const dialog = here.getByRole("dialog");
  // UX-04: one wording on the card button, the dialog title and its confirm button.
  await expect(dialog.getByText("Log out of other devices?")).toBeVisible();
  await dialog.getByRole("button", { name: "Log out of other devices" }).click();
  await expect(card.getByText(/every other device is logged out/i)).toBeVisible();

  // The other browser lands on sign-in at its next step.
  await there.goto("/my-jobs");
  await expect(there).toHaveURL(/\/login\?expired=1/);
  // This one is still signed in, on a page and through the API.
  await here.reload();
  await expect(emailCard(here).getByRole("heading", { name: "Email" })).toBeVisible();
  expect((await here.request.get("/api/auth/me")).status()).toBe(200);
});

test("portal: a client changes their email on My account and logs out their other devices", async ({ api, pageWithState }) => {
  await skipWhenEmailConfigured(api);
  const { clientId } = await api.createClient("Acct portal", { portal: true });
  const client = await api.inviteUser("client", { label: "Acct portal", clientId });
  const page = await pageWithState(await storageFor(client.email, client.tempPassword));
  const otherDevice = await loginApi(client.email, client.tempPassword);
  try {
    await openAccount(page, "/portal/account");
    // UX-12: one name for the page ("My account"), and the email only in its own card (no greyed-out copy in Profile).
    await expect(page.getByRole("heading", { level: 1, name: "My account" })).toBeVisible();
    await expect(page.getByText(/to change it, use/i)).toHaveCount(0);

    const newEmail = `e2e-client-moved-${stamp()}@example.test`;
    await submitEmailChange(page, newEmail, client.tempPassword);
    await expect(page.getByText("Email changed").first()).toBeVisible();
    await expect(emailCard(page).locator("[data-account-email]")).toHaveText(newEmail);
    await expectSignInWorks(newEmail, client.tempPassword);

    const devices = page.locator("section#devices");
    await devices.getByRole("button", { name: "Log out of other devices" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Log out of other devices" }).click();
    await expect(devices.getByText(/every other device is logged out/i)).toBeVisible();
    expect((await otherDevice.raw("GET", "/api/auth/me")).status).toBe(401);
    expect((await page.request.get("/api/auth/me")).status()).toBe(200);
  } finally {
    await otherDevice.dispose();
  }
});

test("/change-email: nothing happens on opening the link; a dead link says so after the button press", async ({ page }) => {
  // No token at all → the dead-link card straight away.
  await page.goto("/change-email");
  await expect(page.getByRole("heading", { name: "This email change link is no longer valid" }).first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole("link", { name: "Go to sign in" })).toBeVisible();

  // A well-formed link: the page only offers the button (mail scanners open links, so GET never confirms).
  await page.goto(`/change-email?token=${bogusToken()}`);
  await expect(page.getByRole("heading", { name: "Confirm your new email" })).toBeVisible({ timeout: 90_000 });
  const button = page.getByRole("button", { name: "Confirm my new email" });
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.getByText("This email change link is no longer valid").first()).toBeVisible();
  await expect(page.getByText(/these links work once and last 24 hours/i)).toBeVisible();

  // The API agrees: a plain 400 that names the reason for the page, never a sign-in.
  const anon = await newApi();
  try {
    const res = await anon.raw("POST", "/api/auth/email-change/confirm", { token: bogusToken() });
    expect(res.status).toBe(400);
    expect(res.error?.details).toMatchObject({ reason: "invalid_link" });
    expect((await anon.raw("GET", "/api/auth/email-change/confirm")).status).toBe(405);
  } finally {
    await anon.dispose();
  }
  expect(await sessionCookie(page)).toBeUndefined();
});

test("API contract: the account routes are self-only, refuse bad input plainly and rate-limit email changes", async ({ api }) => {
  const editor = await api.inviteUser("editor", "Acct api");
  const session = await loginApi(editor.email, editor.tempPassword);
  const anon = await newApi();
  try {
    for (const path of ["/api/auth/email-change", "/api/auth/email-change/resend", "/api/auth/email-change/cancel", "/api/auth/set-password", "/api/auth/sign-out-others"]) {
      expect((await anon.raw("POST", path, {})).status, path).toBe(401);
    }
    // A cross-site POST is refused before anything runs.
    const cross = await session.ctx.post("/api/auth/sign-out-others", { headers: { Origin: "https://evil.example" }, failOnStatusCode: false });
    expect(cross.status()).toBe(403);
    expect((await session.raw("GET", "/api/auth/me")).status).toBe(200);

    // Already has a password → 422; nothing waiting → resend 422, cancel { cancelled: 0 }.
    expect((await session.raw("POST", "/api/auth/set-password", { password: uniqPassword() })).status).toBe(422);
    expect((await session.raw("POST", "/api/auth/email-change/resend")).status).toBe(422);
    expect((await session.raw("POST", "/api/auth/email-change/cancel")).data).toEqual({ cancelled: 0 });

    // Same address → field error; 5 requests an hour, then 429 with a wait.
    const same = await session.raw("POST", "/api/auth/email-change", { newEmail: editor.email, password: editor.tempPassword });
    expect(same.status).toBe(400);
    expect(fieldErrorsOf(same).newEmail).toEqual(["That’s already your email"]);
    for (let i = 0; i < 4; i += 1) await session.raw("POST", "/api/auth/email-change", { newEmail: editor.email, password: `wrong-password-${i}` });
    const limited = await session.raw("POST", "/api/auth/email-change", { newEmail: `e2e-limit-${stamp()}@example.test`, password: editor.tempPassword });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  } finally {
    await session.dispose();
    await anon.dispose();
  }
});
