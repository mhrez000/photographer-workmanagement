import type { Locator, Page } from "@playwright/test";
import { BASE_URL, fieldErrorsOf, newApi, signUpStudio, uniqPassword } from "./api";
import { UI_TEST_TIMEOUT, emailBox, expect, expectNoHorizontalOverflow, fillPasswords, publicForm, storageFor, submitButton, test, waitForHydration } from "./fixtures";

/**
 * Accounts — AREA access (docs/ACCOUNTS.md §1, §6, §7): signed-in visitors on the front door, the sign-up honeypot
 * and the pending-invitee answer, the caps-lock hint, plain-words rate limits, and the demo studio's sign-in panel.
 *
 * The e2e studio is NOT a demo studio (SEED_DEMO=off), so here the demo panel is hidden and POST /api/auth/demo is a
 * 404; the panel flow itself runs only against a server that offers it (e.g. after `SEED_DEMO=on npm run e2e:prepare`).
 * Nothing here signs a seeded account out: every log-out uses a throwaway studio. The tests that need an ORDINARY
 * studio create their own (`signUpStudio`), so the whole file also passes against a server whose seeded owner is in the
 * demo studio (DEMO-09) — there the demo tests run, and nothing fails because invites are off in the demo.
 */

test.use({ role: "anon" });
test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PENDING_INVITE_MESSAGE = "This email has been invited to a studio. Use the invite link in your email, or ask the studio to send it again.";
const PLAIN_WAIT = /Try again in (a minute|\d+ minutes)\./;

/** Holds Caps Lock down for one key press in a field (browsers only report it on key events). */
async function pressWithCapsLock(field: Locator): Promise<void> {
  await field.focus();
  await field.evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "A", bubbles: true, modifierCapsLock: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key: "A", bubbles: true, modifierCapsLock: true }));
  });
}

async function demoPanelOffered(page: Page): Promise<boolean> {
  await page.goto("/login?demo=1", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  return (await page.locator("[data-demo-panel]").count()) > 0;
}

test.describe("signed-in visitors on the front door", () => {
  test("/login and /signup say who is signed in, go back to the studio, or log out (landing back on the same page, logged out)", async ({ pageWithState }) => {
    const studio = await signUpStudio("Notice");
    const page = await pageWithState(await storageFor(studio.email, studio.password));
    try {
      for (const path of ["/login", "/signup", "/login?demo=1"]) {
        await page.goto(path, { waitUntil: "domcontentloaded" });
        const notice = page.locator("[data-signed-in-notice]");
        await expect(notice, path).toBeVisible();
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(/you.re already signed in/i);
        await expect(notice.getByRole("heading", { name: studio.ownerName })).toBeVisible();
        await expect(notice).toContainText(studio.email);
        // UX-03: logging out is said to reach every device.
        await expect(notice).toContainText("Logging out also logs you out on your other devices.");
        await expect(notice.getByRole("link", { name: /go to your studio/i })).toHaveAttribute("href", "/home");
        await expect(notice.getByRole("button", { name: /^log out$/i })).toBeVisible();
        // No form at all: signing in or creating a studio here would silently replace the session.
        await expect(page.locator('input[type="password"]'), path).toHaveCount(0);
        await expect(page.locator("[data-demo-panel]"), path).toHaveCount(0);
      }
      // The landing page too: one obvious way back.
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("banner").getByRole("link", { name: /go to your studio/i })).toHaveAttribute("href", "/home");
      await expect(page.getByRole("banner")).toContainText(studio.ownerName);

      // Go to your studio.
      await page.goto("/signup", { waitUntil: "domcontentloaded" });
      await page.locator("[data-signed-in-notice]").getByRole("link", { name: /go to your studio/i }).click();
      await expect(page).toHaveURL(/\/home/, { timeout: 60_000 });

      // Log out from /signup: back on /signup with the form, really logged out.
      await page.goto("/signup", { waitUntil: "domcontentloaded" });
      await page.locator("[data-signed-in-notice]").getByRole("button", { name: /^log out$/i }).click();
      await expect(page).toHaveURL(/\/signup$/, { timeout: 30_000 });
      await expect(page.locator("[data-signed-in-notice]")).toHaveCount(0);
      await expect(publicForm(page).locator('input[type="password"]')).toHaveCount(1);
      expect((await page.request.get("/api/auth/me")).status()).toBe(401);
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("banner").locator('a[href^="/login"]').first()).toBeVisible();
      await expect(page.getByRole("banner").getByRole("link", { name: /go to your studio/i })).toHaveCount(0);
    } finally {
      await studio.api.dispose();
    }
  });

  test("a stale session (?expired=1) gets the form, not the notice", async ({ pageWithState }) => {
    const studio = await signUpStudio("Expired");
    const page = await pageWithState(await storageFor(studio.email, studio.password));
    try {
      await page.goto("/login?expired=1", { waitUntil: "domcontentloaded" });
      await expect(page.locator("[data-signed-in-notice]")).toHaveCount(0);
      await expect(page.getByText("You’ve been logged out on this device. Sign in again to carry on.")).toBeVisible();
      await expect(publicForm(page).locator('input[type="password"]')).toHaveCount(1);
      // …and the proxy threw that cookie away.
      expect((await page.context().cookies()).find((c) => c.name === "pwm_session")).toBeUndefined();
    } finally {
      await studio.api.dispose();
    }
  });
});

test.describe("Create your studio: honeypot, pending invitees, caps lock", () => {
  test("API: a filled honeypot gets the one generic 400 and nothing is created", async () => {
    const anon = await newApi();
    try {
      const email = `e2e-bot-${stamp()}@example.test`;
      const res = await anon.signup({ ownerName: "Bot", email, password: uniqPassword(), studioName: `Bot Studio ${stamp()}`, website: "https://spam.example" });
      expect(res.status).toBe(400);
      expect(res.error?.message).toBe("Something went wrong. Please try again.");
      expect(fieldErrorsOf(res)).toEqual({});
      expect((await anon.raw("GET", "/api/auth/me")).status).toBe(401);
      // Nothing was created: the same address signs up normally (an empty honeypot is fine).
      const ok = await anon.signup({ ownerName: "Real Person", email, password: uniqPassword(), studioName: `Real Studio ${stamp()}`, website: "" });
      expect(ok.status, JSON.stringify(ok.error)).toBe(200);
    } finally {
      await anon.dispose();
    }
  });

  test("an invited address that has not joined yet is told to use the invite link (API and form), never the studio's name", async ({ page }) => {
    // An ordinary studio of its own: the seeded one may be the demo studio, where invites are off (DEMO-09).
    const studio = await signUpStudio("Pending signup");
    const api = studio.api;
    const invite = await api.inviteByLink("editor", "Pending signup");
    const studioName = (await api.settings()).organisation.name;
    const anon = await newApi();
    try {
      const res = await anon.signup({ ownerName: "Sam", email: invite.email, password: uniqPassword(), studioName: `Mine ${stamp()}` });
      expect(res.status).toBe(400);
      expect(fieldErrorsOf(res).email).toEqual([PENDING_INVITE_MESSAGE]);
      expect(JSON.stringify(res.error)).not.toContain(studioName);

      await page.goto("/signup", { waitUntil: "domcontentloaded" });
      const form = publicForm(page);
      await form.getByRole("textbox", { name: /^your name/i }).fill("Sam Pending");
      await emailBox(form).fill(invite.email);
      await fillPasswords(form, uniqPassword());
      await form.getByRole("textbox", { name: /^studio name/i }).fill(`Mine ${stamp()}`);
      await submitButton(form).click();
      await expect(page.getByRole("alert").filter({ hasText: PENDING_INVITE_MESSAGE })).toBeVisible({ timeout: 30_000 });
      // Not "already in use": no "Sign in instead" for someone who has no password yet.
      await expect(form.getByRole("link", { name: /sign in instead/i })).toHaveCount(0);
      await expect(page).toHaveURL(/\/signup/);
    } finally {
      await anon.dispose();
      await api.revokeInvite(invite.user.id);
      await api.dispose();
    }
  });

  test("the form: the honeypot is invisible and out of reach, the invitee line is there, Caps Lock is pointed out", async ({ page }) => {
    await page.goto("/signup", { waitUntil: "domcontentloaded" });
    await waitForHydration(page);
    await expect(page.getByText("Editing for a studio, or a client? Use the invite link your studio sent you.")).toBeVisible();

    // Honeypot: present for bots, absent for people (accessibility tree, tab order, autofill, the screen).
    const trap = page.locator('[data-honeypot] input[name="website"]');
    await expect(trap).toHaveCount(1);
    await expect(trap).toHaveAttribute("tabindex", "-1");
    await expect(trap).toHaveAttribute("autocomplete", "off");
    await expect(page.locator("[data-honeypot]")).toHaveAttribute("aria-hidden", "true");
    await expect(page.getByRole("textbox", { name: /website/i })).toHaveCount(0);
    const box = await trap.boundingBox();
    expect(box && box.x + box.width < 0, `honeypot box ${JSON.stringify(box)}`).toBe(true);
    // Tabbing through the whole form never lands on it.
    await page.getByRole("textbox", { name: /^your name/i }).focus();
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("name"))).not.toBe("website");
    }
    await expectNoHorizontalOverflow(page);

    // Caps Lock: a quiet line under the password while it is on, gone when the field is left.
    const password = publicForm(page).locator('input[type="password"]');
    await expect(page.locator("[data-caps-lock-hint]")).toHaveCount(0);
    await pressWithCapsLock(password);
    await expect(page.locator("[data-caps-lock-hint]")).toHaveText(/caps lock is on/i);
    const hintId = await page.locator("[data-caps-lock-hint]").getAttribute("id");
    await expect(password).toHaveAttribute("aria-describedby", new RegExp(hintId ?? "missing"));
    await page.getByRole("textbox", { name: /^studio name/i }).focus();
    await expect(page.locator("[data-caps-lock-hint]")).toHaveCount(0);
  });
});

test.describe("Sign in: caps lock and the plain-words limit", () => {
  test("Caps Lock is pointed out on the sign-in password too", async ({ page }) => {
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await waitForHydration(page);
    const password = publicForm(page).locator('input[type="password"]');
    await pressWithCapsLock(password);
    await expect(page.locator("[data-caps-lock-hint]")).toHaveText(/caps lock is on/i);
    await emailBox(publicForm(page)).focus();
    await expect(page.locator("[data-caps-lock-hint]")).toHaveCount(0);
  });

  test("five wrong passwords: the form says how many minutes to wait and offers the way out; the API answers 429 with retry-after", async ({ page }) => {
    // An ordinary studio of its own: the seeded one may be the demo studio, where invites are off (DEMO-09).
    const studio = await signUpStudio("Lockout");
    const api = studio.api;
    const user = await api.inviteUser("editor", "Lockout");
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    const form = publicForm(page);
    const passwordBox = form.locator('input[type="password"]');
    for (let i = 1; i <= 5; i += 1) {
      await emailBox(form).fill(user.email);
      await passwordBox.fill(`wrong-password-${i}`);
      await submitButton(form).click();
      // The form clears the password once the answer is back: wait for that before reading it.
      await expect(passwordBox).toHaveValue("", { timeout: 30_000 });
      const strip = page.locator("[data-login-error]");
      await expect(strip).toHaveAttribute("data-login-error", i < 5 ? "refused" : "throttled", { timeout: 30_000 });
      if (i < 5) {
        await expect(strip).toContainText(/incorrect email or password/i);
        // UX-02: the way out leads, every time.
        await expect(strip.getByRole("link", { name: "Reset it" })).toHaveAttribute("href", `/forgot-password?email=${encodeURIComponent(user.email)}`);
      }
    }
    await expect(page.locator("[data-login-error]")).toContainText(/^Too many sign-in attempts\. Try again in \d+ minutes\./);
    // UX-02: a lockout is not a dead end — a reset works straight away.
    await expect(page.locator("[data-login-error]").getByRole("link", { name: "reset your password now" })).toBeVisible();
    // Even the right password waits now.
    const res = await page.request.post("/api/auth/login", { data: { email: user.email, password: user.tempPassword }, headers: { Origin: BASE_URL } });
    expect(res.status()).toBe(429);
    expect(Number(res.headers()["retry-after"])).toBeGreaterThan(0);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(PLAIN_WAIT);
    await api.deactivateUser(user.user.id);
    await api.dispose();
  });

  test("Forgot password: the sixth request for one address answers 429 in plain words", async () => {
    const anon = await newApi();
    try {
      const email = `e2e-forgot-${stamp()}@example.test`;
      for (let i = 0; i < 5; i += 1) expect((await anon.forgotPassword(email)).status).toBe(200);
      const blocked = await anon.forgotPassword(email);
      expect(blocked.status).toBe(429);
      expect(blocked.error?.message).toMatch(/^Too many reset emails asked for\. Try again in \d+ minutes\.$/);
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    } finally {
      await anon.dispose();
    }
  });
});

test.describe("the demo studio", () => {
  test("the demo endpoint and panel follow what the server offers (here: no demo studio → hidden + 404)", async ({ page }) => {
    const offered = await demoPanelOffered(page);
    const anon = await newApi();
    try {
      const res = await anon.raw("POST", "/api/auth/demo", { persona: "owner" });
      if (offered) {
        expect(res.status).toBe(200);
      } else {
        expect(res.status).toBe(404);
        expect(res.error?.message).toBe("The demo studio is turned off");
        await expect(page.locator("[data-demo-panel]")).toHaveCount(0);
        await expect(page.getByText(/demo studio isn.t open right now/i)).toBeVisible();
      }
      expect((await anon.raw("GET", "/api/auth/demo")).status).toBe(405);
    } finally {
      await anon.dispose();
    }
  });

  test("Look around as a persona → their home in the demo studio, the banner, then Create your own studio signs this browser out", async ({ page }) => {
    test.skip(!(await demoPanelOffered(page)), "this server has no demo studio (the e2e database is seeded with SEED_DEMO=off)");
    const panel = page.locator("[data-demo-panel]");
    await expect(panel).toHaveAttribute("data-highlighted", "");
    await expect(panel).not.toContainText(/@|Password123!/);
    await panel.getByRole("button", { name: /look around as editor/i }).click();
    await expect(page).toHaveURL(/\/my-jobs/, { timeout: 60_000 });
    const banner = page.locator("[data-demo-studio-banner]");
    await expect(banner).toContainText(/you.re looking at the demo studio\. anyone can see changes here\./i);
    // Invites, passwords and the like are off in there.
    expect((await page.request.post("/api/auth/change-password", { data: { current: "x", next: uniqPassword() }, headers: { Origin: BASE_URL } })).status()).toBe(403);
    await banner.getByRole("button", { name: /create your own studio/i }).click();
    await expect(page).toHaveURL(/\/signup$/, { timeout: 30_000 });
    await expect(publicForm(page).locator('input[type="password"]')).toHaveCount(1);
    expect((await page.request.get("/api/auth/me")).status()).toBe(401);
  });
});

test.describe("Settings → People outside the demo", () => {
  test.use({ role: "owner" });
  test("an ordinary studio keeps its Invite button (the demo-only explanation is absent)", async ({ page }) => {
    await page.goto("/settings/people", { waitUntil: "domcontentloaded" });
    // DEMO-09: against a server whose seeded owner IS in the demo studio this check does not apply.
    test.skip((await page.locator("[data-demo-studio-banner]").count()) > 0, "the seeded owner is in the demo studio on this server");
    await expect(page.locator("[data-invite-button]")).toBeVisible();
    await expect(page.locator("[data-invite-blocked]")).toHaveCount(0);
  });
});
