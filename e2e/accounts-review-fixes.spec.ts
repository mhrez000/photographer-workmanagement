import { BASE_URL, localPath, newApi, signUpStudio, uniqPassword } from "./api";
import { UI_TEST_TIMEOUT, emailBox, expect, fillPasswords, publicForm, submitButton, test, waitForHydration } from "./fixtures";

/**
 * The accounts review fixes, end to end against the running server (docs/ACCOUNTS-PLAN.md §8 "Review fixes"):
 *
 *   SEC-02  the real sign-in form never leaves the site, whatever characters `next` hides
 *   SEC-04  sign-up's "is this address taken?" answer is rate-limited like any sign-up
 *   UX-01   five wrong passwords → reset → the NEW password works straight away (and a toast says it is set)
 *   UX-06   reopening your own used invite link says you've already joined; signed out, "Sign in" is the one action
 *   UX-14   a dead invite link has one heading and one sign-in action
 *   UX-18   "Send it again" on Forgot password really sends again
 *   DEMO-06 every response says it may not be framed by another site
 *   DEMO-08 a mangled invite address lands on the dead-link card / a plain 400, never a 500
 *
 * Every account here belongs to a throwaway studio (`signUpStudio`); nothing touches the seeded people.
 */

test.use({ role: "anon" });
test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test("SEC-02: a `next` hiding a TAB / newline / backslash never sends the browser to another site after signing in", async ({ page }) => {
  const studio = await signUpStudio("Next guard");
  try {
    // The API answer: home, not the smuggled host.
    // …including dot segments that normalise into a protocol-relative "//evil.example" (final verification).
    for (const next of ["/\t/evil.example/phish", "/\n/evil.example", "/\\evil.example", "/.//evil.example/phish", "/a/..//evil.example", "/%2e//evil.example"]) {
      const res = await page.request.post("/api/auth/login", { data: { email: studio.email, password: studio.password, next }, headers: { Origin: BASE_URL } });
      expect(res.status(), JSON.stringify(next)).toBe(200);
      expect(((await res.json()) as { data: { redirectTo: string } }).data.redirectTo, JSON.stringify(next)).toBe("/home");
    }
    await page.context().clearCookies();
    // The real form, opened from a crafted link.
    await page.goto(`/login?next=${encodeURIComponent("/\t/evil.example/phish")}`, { waitUntil: "domcontentloaded" });
    await waitForHydration(page);
    const form = publicForm(page);
    await emailBox(form).fill(studio.email);
    await form.locator('input[type="password"]').fill(studio.password);
    await submitButton(form).click();
    await expect(page).toHaveURL(/\/home/, { timeout: 60_000 });
    expect(new URL(page.url()).origin).toBe(new URL(BASE_URL).origin);
  } finally {
    await studio.api.dispose();
  }
});

test("SEC-04: sign-up's 'is this address taken?' answer is throttled like any sign-up", async () => {
  const anon = await newApi();
  try {
    const target = `e2e-probe-${stamp()}@example.test`;
    const statuses: number[] = [];
    // Every other field wrong (a too-short password): only the address is being probed.
    for (let i = 0; i < 7; i += 1) {
      statuses.push((await anon.signup({ ownerName: "P", email: target, password: "short", studioName: `Probe ${stamp()}` })).status);
    }
    expect(statuses.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  } finally {
    await anon.dispose();
  }
});

test("UX-01: locked out by five wrong passwords, a reset lets the NEW password straight in", async ({ page }) => {
  const studio = await signUpStudio("Locked reset");
  const anon = await newApi();
  try {
    test.skip((await studio.api.emailSettings()).configured, "email is configured on this server: the reset link is emailed, not shown");
    for (let i = 0; i < 5; i += 1) await anon.raw("POST", "/api/auth/login", { email: studio.email, password: `wrong-${i}` });
    expect((await anon.raw("POST", "/api/auth/login", { email: studio.email, password: studio.password })).status).toBe(429);

    const forgot = await anon.forgotPassword(studio.email);
    const link = forgot.data.resetUrl;
    expect(link, "a dev-only reset link").toBeTruthy();
    const next = uniqPassword();
    await page.goto(localPath(link ?? ""), { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/choose a new password/i);
    const reset = publicForm(page);
    await fillPasswords(reset, next);
    await submitButton(reset).click();
    await expect(page).toHaveURL(/\/home/, { timeout: 60_000 });
    // UX-19: a toast says the new password is set.
    await expect(page.getByText("Your new password is set")).toBeVisible({ timeout: 15_000 });

    // A brand-new browser (no history with this address): the new password works at once.
    const fresh = await newApi();
    try {
      const login = await fresh.raw("POST", "/api/auth/login", { email: studio.email, password: next });
      expect(login.status, JSON.stringify(login.error)).toBe(200);
    } finally {
      await fresh.dispose();
    }
  } finally {
    await anon.dispose();
    await studio.api.dispose();
  }
});

test("UX-06 / UX-14: a used invite link — signed in as its owner 'you've already joined'; signed out, one heading and one 'Sign in'", async ({ page }) => {
  const studio = await signUpStudio("Joined");
  try {
    const invite = await studio.api.inviteByLink("editor", "Joined");
    // Joining with the link signs THIS browser in as the editor.
    const accepted = await page.request.post(`/api/auth/invite/${invite.token}/accept`, { data: { password: uniqPassword() }, headers: { Origin: BASE_URL } });
    expect(accepted.status()).toBe(200);

    await page.goto(`/invite/${invite.token}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-invite-state="already_joined"]')).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`You’ve already joined ${studio.studioName}`);
    await expect(page.getByRole("link", { name: "Go to my jobs" })).toHaveAttribute("href", "/my-jobs");
    await expect(page).toHaveTitle(/Invite link no longer valid/);

    // Signed out: the dead-link card, one heading, "Already joined? Sign in" first, and ONE way to sign in.
    await page.context().clearCookies();
    await page.goto(`/invite/${invite.token}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("This invite link is no longer valid");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 2 })).toHaveCount(0);
    await expect(page.locator("[data-invalid-link]")).toContainText("Already joined? Sign in below.");
    await expect(page.locator("[data-invalid-link]")).not.toContainText(/didn.t open/);
    await expect(main.locator('a[href^="/login"]')).toHaveCount(1);
    await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login?from=invite");
  } finally {
    await studio.api.dispose();
  }
});

test("UX-18: 'Send it again' on Forgot password sends again (and says so)", async ({ page }) => {
  await page.goto("/forgot-password", { waitUntil: "domcontentloaded" });
  await waitForHydration(page);
  const form = publicForm(page);
  await emailBox(form).fill(`e2e-again-${stamp()}@example.test`);
  await submitButton(form).click();
  await expect(page.getByText(/if that email has an account/i)).toBeVisible({ timeout: 30_000 });
  const sent = page.waitForResponse((r) => r.url().endsWith("/api/auth/forgot-password") && r.request().method() === "POST");
  await page.locator("[data-send-again]").click();
  expect((await sent).status()).toBe(200);
  await expect(page.getByText("Sent again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "use a different email" })).toBeVisible();
});

test("DEMO-06: pages and API answers may not be framed by another site", async ({ page }) => {
  for (const path of ["/login", "/", "/api/auth/me"]) {
    const res = await page.request.get(path, { maxRedirects: 0, failOnStatusCode: false });
    const headers = res.headers();
    expect(headers["x-frame-options"], path).toBe("DENY");
    expect(headers["content-security-policy"], path).toContain("frame-ancestors 'none'");
    expect(headers["x-content-type-options"], path).toBe("nosniff");
    expect(headers["referrer-policy"], path).toBe("strict-origin-when-cross-origin");
  }
});

test("DEMO-08: a mangled invite address lands on the friendly dead-link card (and the API answers a plain 400)", async ({ page }) => {
  const anon = await newApi();
  try {
    const pageRes = await anon.pageStatus("/invite/%E0%A4%A");
    expect([302, 303, 307, 308]).toContain(pageRes.status);
    expect(pageRes.location ?? "").toContain("/invite/link-not-valid");
    const api = await anon.raw("GET", "/api/auth/invite/%E0%A4%A");
    expect(api.status).toBe(400);
    expect(api.error).toMatchObject({ code: "validation" });
  } finally {
    await anon.dispose();
  }
  await page.goto("/invite/%E0%A4%A", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This invite link is no longer valid");
});
