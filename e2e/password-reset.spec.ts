import { PASSWORD_TOO_SHORT_MESSAGE, RESET_INVALID_MESSAGE, RESET_LINK_RE, bogusToken, fieldErrorsOf, localPath, loginApi, newApi, signUpStudio, tokenOfResetUrl, uniqPassword } from "./api";
import { UI_TEST_TIMEOUT, emailBox, expect, fillPasswords, findLink, publicForm, sessionCookie, submitButton, test } from "./fixtures";

/**
 * Forgot / reset password (front door): "Forgot your password?" never says whether an address has an
 * account; a 60-minute single-use link is made for an active, accepted user (emailed when email is set
 * up — on the dev server it is shown on the page instead); choosing a new password signs the person in
 * here and out everywhere else; a dead link says so plainly. Every test resets a user it created
 * (its own studio), never a demo account.
 */

test.use({ role: "anon" });
test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

test("API contract: the same answer for any email; reset signs in, revokes other sessions, is single use and supersedes older links", async () => {
  const studio = await signUpStudio("Reset api");
  const other = await loginApi(studio.email, studio.password); // a second device, still signed in
  const anon = await newApi();
  try {
    // Unknown address: ok, nothing more.
    const nobody = await anon.forgotPassword(`e2e-nobody-${Date.now().toString(36)}@example.test`);
    expect(nobody.status).toBe(200);
    expect(nobody.data).toMatchObject({ ok: true, emailed: false });
    expect(nobody.data.resetUrl).toBeUndefined();
    // Known address: ok; the dev server has no email, so the link comes back for the flow.
    const asked = await anon.forgotPassword(studio.email.toUpperCase());
    expect(asked.status).toBe(200);
    expect(asked.data.ok).toBe(true);
    const email = await studio.api.emailSettings();
    test.skip(email.configured, "email is configured on this server: the reset link is emailed, not shown");
    expect(asked.data.resetUrl, "local dev without email returns the link").toMatch(RESET_LINK_RE);
    const token = tokenOfResetUrl(asked.data.resetUrl!);

    // A made-up token, a weak password: 400s that say nothing about accounts; the live link survives a weak try.
    const bad = await anon.resetPassword(bogusToken(), uniqPassword());
    expect(bad.status).toBe(400);
    expect(bad.error?.message).toBe(RESET_INVALID_MESSAGE);
    const weak = await anon.resetPassword(token, "short");
    expect(weak.status).toBe(400);
    expect(fieldErrorsOf(weak).password?.[0]).toBe(PASSWORD_TOO_SHORT_MESSAGE);
    expect((await anon.raw("GET", "/api/auth/me")).status).toBe(401);

    // Reset: signed in here, out everywhere else, the link used up.
    const next = uniqPassword();
    const reset = await anon.resetPassword(token, next);
    expect(reset.status, JSON.stringify(reset.error)).toBe(200);
    expect(reset.data).toMatchObject({ ok: true, redirectTo: "/home" });
    expect((await anon.me()).user.email).toBe(studio.email);
    expect((await other.raw("GET", "/api/auth/me")).status).toBe(401);
    expect((await studio.api.raw("GET", "/api/auth/me")).status).toBe(401);
    const again = await anon.resetPassword(token, uniqPassword());
    expect(again.status).toBe(400);
    expect(again.error?.message).toBe(RESET_INVALID_MESSAGE);
    // The old password is gone, the new one works.
    const anon2 = await newApi();
    expect((await anon2.raw("POST", "/api/auth/login", { email: studio.email, password: studio.password })).status).toBe(401);
    await anon2.dispose();
    const fresh = await loginApi(studio.email, next);
    expect((await fresh.me()).user.isPrimaryOwner).toBe(true);
    // The history: a request and a change, never a token or a password.
    const feed = await fresh.get<{ items: { eventType: string }[] }>("/api/activity?limit=100");
    const types = feed.items.map((e) => e.eventType);
    expect(types).toContain("auth.password_reset_requested");
    expect(types).toContain("user.password_changed");
    const text = JSON.stringify(feed);
    expect(text).not.toContain(token);
    expect(text).not.toContain(next);
    await fresh.dispose();

    // Asking twice: only the newest link works.
    const anon3 = await newApi();
    const first = await anon3.forgotPassword(studio.email);
    const second = await anon3.forgotPassword(studio.email);
    expect((await anon3.resetPassword(tokenOfResetUrl(first.data.resetUrl!), uniqPassword())).status).toBe(400);
    expect((await anon3.resetPassword(tokenOfResetUrl(second.data.resetUrl!), uniqPassword())).status).toBe(200);
    await anon3.dispose();
  } finally {
    await other.dispose();
    await anon.dispose();
    await studio.api.dispose();
  }
});

test("Forgot your password? → the link → a new password → signed in here, signed out elsewhere", async ({ page }) => {
  const studio = await signUpStudio("Reset ui");
  const other = await loginApi(studio.email, studio.password);
  try {
    test.skip((await studio.api.emailSettings()).configured, "email is configured on this server: the reset link is emailed, not shown");
    // From the sign-in page.
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await page.locator('a[href^="/forgot-password"]').first().click();
    await expect(page).toHaveURL(/\/forgot-password/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/forgot your password/i);
    const form = publicForm(page);
    await emailBox(form).fill(studio.email);
    await submitButton(form).click();

    // A calm confirmation that never reveals whether the account exists…
    await expect(page.getByRole("status").or(page.getByRole("alert")).filter({ hasText: /if that email has an account/i })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("body")).toContainText(/60 minutes/);
    // …and, on a dev server without email, the link itself.
    const body = page.locator("body");
    await expect.poll(() => findLink(body, RESET_LINK_RE), { timeout: 15_000 }).not.toBeNull();
    const link = (await findLink(body, RESET_LINK_RE)) as string;

    await page.goto(localPath(link), { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/choose a new password/i);
    const next = uniqPassword();
    const reset = publicForm(page);
    await fillPasswords(reset, next);
    await submitButton(reset).click();
    await expect(page).toHaveURL(/\/home/, { timeout: 60_000 });
    await expect(page.getByRole("banner").getByRole("button", { name: `Account menu for ${studio.ownerName}` })).toBeVisible();
    expect((await other.raw("GET", "/api/auth/me")).status).toBe(401);
    const session = await loginApi(studio.email, next);
    expect((await session.me()).user.email).toBe(studio.email);
    await session.dispose();
  } finally {
    await other.dispose();
    await studio.api.dispose();
  }
});

test("an unknown email gets the same calm answer; a dead or missing link says so and offers a new one", async ({ page }) => {
  await page.goto("/forgot-password", { waitUntil: "domcontentloaded" });
  const form = publicForm(page);
  await emailBox(form).fill(`e2e-nobody-${Date.now().toString(36)}@example.test`);
  await submitButton(form).click();
  await expect(page.getByRole("status").or(page.getByRole("alert")).filter({ hasText: /if that email has an account/i })).toBeVisible({ timeout: 30_000 });
  expect(await findLink(page.locator("body"), RESET_LINK_RE)).toBeNull();
  await expect(page.locator('a[href^="/login"]').first()).toBeVisible();

  // A link nobody issued: the form is there, but submitting says the link is dead.
  await page.goto(`/reset-password?token=${bogusToken()}`, { waitUntil: "domcontentloaded" });
  const reset = publicForm(page);
  await fillPasswords(reset, uniqPassword());
  await submitButton(reset).click();
  await expect(page.getByRole("alert").filter({ hasText: RESET_INVALID_MESSAGE })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('a[href^="/forgot-password"]').first()).toBeVisible();
  expect(await sessionCookie(page)).toBeUndefined();

  // No token at all: the dead-link card straight away, no password boxes.
  await page.goto("/reset-password", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("alert").filter({ hasText: RESET_INVALID_MESSAGE })).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.locator('a[href^="/forgot-password"]').first()).toBeVisible();
});
