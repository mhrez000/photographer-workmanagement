import type { Page } from "@playwright/test";
import { bogusToken, localPath, newApi, signUpStudio, uniqPassword, type Api, type Studio } from "./api";
import { UI_TEST_TIMEOUT, emailBox, expect, storageFor, test } from "./fixtures";

/**
 * "Confirm your email" end to end (AREA verify, docs/ACCOUNTS.md §3). The shared dev server has NO mail provider, so:
 * the "Please confirm your email" banner never shows (the configured case is covered in vitest:
 * src/components/account/email-confirmation-ui.test.ts), and "Send again" hands back the dev-only link, which these
 * specs open. The link page confirms on the BUTTON press only, works signed in or out, never signs anyone in, and
 * says plainly what to do with a used, replaced or broken link. Every test signs up its own studio.
 */

test.use({ role: "anon" });
test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

const CONFIRM_LINK_RE = /^https?:\/\/[^/]+\/verify-email\?token=[A-Za-z0-9_-]{43}$/;
const CONFIRM_LINK_INVALID_MESSAGE = "This confirmation link is no longer valid";

interface SendResult {
  sent: boolean;
  reason: string | null;
  devLink?: string;
  expiresAt?: string;
}

/** "Send again" through the API as the studio's owner; returns the dev-only link (the server has no email). */
async function devLink(api: Api): Promise<string> {
  const res = await api.raw<SendResult>("POST", "/api/auth/email-verification/resend");
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  expect(res.data).toMatchObject({ sent: false, reason: "not_configured" });
  expect(res.data.devLink, "local dev without email returns the link").toMatch(CONFIRM_LINK_RE);
  return res.data.devLink!;
}

async function skipWhenEmailIsConfigured(studio: Studio): Promise<void> {
  const email = await studio.api.emailSettings();
  test.skip(email.configured, "email is configured on this server: confirm links are emailed, not shown");
}

function tokenOf(link: string): string {
  return new URL(link).searchParams.get("token") ?? "";
}

/** Same length and alphabet, one character different: a link pasted with a typo. */
function tampered(link: string): string {
  const token = tokenOf(link);
  const last = token.at(-1) === "A" ? "B" : "A";
  return `/verify-email?token=${token.slice(0, -1)}${last}`;
}

async function pressConfirm(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: "Confirm my email" });
  await expect(button).toBeVisible();
  await button.click();
}

test("the sign-up response itself carries the dev-only confirm link (no mail provider), and it works", async () => {
  const anon = await newApi();
  const signedUp = await newApi();
  try {
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const email = `e2e-verify-signup-${stamp}@example.test`;
    const res = await signedUp.signup({ ownerName: `E2E Verify Signup ${stamp}`, email, password: uniqPassword(), studioName: `E2E Verify Signup Studio ${stamp}` });
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    const confirmation = res.data.emailConfirmation;
    test.skip(confirmation?.reason !== "not_configured", "email is configured on this server: the link is emailed, not returned");
    expect(confirmation).toMatchObject({ sent: false, reason: "not_configured" });
    expect(confirmation?.devLink).toMatch(CONFIRM_LINK_RE);
    expect(confirmation?.expiresAt).toEqual(expect.any(String));
    // The link from the sign-up response confirms the new owner's address on the button press.
    const ok = await anon.raw<{ ok: boolean; email: string; signedIn: boolean }>("POST", "/api/auth/verify-email", { token: tokenOf(confirmation?.devLink ?? "") });
    expect(ok.status, JSON.stringify(ok.error)).toBe(200);
    expect(ok.data).toMatchObject({ ok: true, email, signedIn: false });
  } finally {
    await anon.dispose();
    await signedUp.dispose();
  }
});

test("API contract: the dev-only link, confirm on POST only (never GET), never signs in, single use, 422 once confirmed", async () => {
  const studio = await signUpStudio("Verify api");
  const anon = await newApi();
  try {
    await skipWhenEmailIsConfigured(studio);
    const link = await devLink(studio.api);

    // Opening the link (GET on the API) confirms nothing.
    const get = await anon.raw("GET", `/api/auth/verify-email?token=${tokenOf(link)}`);
    expect(get.status).toBe(405);
    expect(get.error?.code).toBe("method_not_allowed");

    // The button press: confirmed, nobody signed in, Continue goes to sign in with the address filled in.
    const ok = await anon.raw<{ ok: boolean; email: string; signedIn: boolean; redirectTo: string }>("POST", "/api/auth/verify-email", { token: tokenOf(link) });
    expect(ok.status, JSON.stringify(ok.error)).toBe(200);
    expect(ok.data).toEqual({ ok: true, email: studio.email, signedIn: false, redirectTo: `/login?email=${encodeURIComponent(studio.email)}` });
    expect((await anon.raw("GET", "/api/auth/me")).status).toBe(401);

    // Used up: the same link again says why (already confirmed), a made-up one is just invalid.
    const again = await anon.raw("POST", "/api/auth/verify-email", { token: tokenOf(link) });
    expect(again.status).toBe(400);
    expect(again.error).toMatchObject({ code: "validation", message: CONFIRM_LINK_INVALID_MESSAGE, details: { reason: "already_confirmed" } });
    const made = await anon.raw("POST", "/api/auth/verify-email", { token: bogusToken() });
    expect(made.status).toBe(400);
    expect(made.error?.details).toMatchObject({ reason: "invalid" });

    // Confirmed: "Send again" has nothing to do.
    const resend = await studio.api.raw("POST", "/api/auth/email-verification/resend");
    expect(resend.status).toBe(422);
    expect(resend.error?.message).toBe("Your email is already confirmed");
    expect((await anon.raw("POST", "/api/auth/email-verification/resend")).status).toBe(401);

    // The studio's history records both steps — never the token.
    const feed = await studio.api.get<{ items: { eventType: string }[] }>("/api/activity?limit=100");
    const types = feed.items.map((e) => e.eventType);
    expect(types).toContain("user.email_confirmation_sent");
    expect(types).toContain("user.email_confirmed");
    expect(JSON.stringify(feed)).not.toContain(tokenOf(link));
  } finally {
    await anon.dispose();
    await studio.api.dispose();
  }
});

test("signed out: no banner without email; the link confirms on the button, then 'already used'; a broken link gets the dead-link card", async ({ page, pageWithState }) => {
  const studio = await signUpStudio("Verify page");
  try {
    await skipWhenEmailIsConfigured(studio);

    // Email is not set up on this server: the owner is never nagged (no banner, no "Not confirmed yet").
    const owner = await pageWithState(await storageFor(studio.email, studio.password));
    await owner.goto("/home");
    await expect(owner.getByRole("main")).toBeVisible();
    await expect(owner.locator("[data-unconfirmed-email-banner]")).toHaveCount(0);
    await owner.goto("/settings/account");
    await expect(owner.getByRole("main")).toBeVisible();
    await expect(owner.locator("[data-email-confirmation]")).toHaveCount(0);

    const link = await devLink(studio.api);

    // Opening the page does nothing by itself: one plain question and one button.
    await page.goto(localPath(link));
    await expect(page.getByRole("heading", { level: 1, name: "Confirm your email" })).toBeVisible();
    await expect(page.getByText("This only confirms your email. It doesn’t sign you in or change anything else.")).toBeVisible();
    await pressConfirm(page);
    await expect(page.getByRole("heading", { name: "Email confirmed" })).toBeVisible();
    await expect(page.locator('[data-verify-state="confirmed"]')).toContainText(studio.email);
    // UX-20: signed out, the next step is simply "Sign in" (no "Continue" plus an explanation).
    await expect(page.getByText("Continue takes you to sign in.")).toHaveCount(0);

    // Sign in → the sign-in page, with the address filled in. Still nobody signed in.
    await page.getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/login\?email=/);
    await expect(emailBox(page.locator("form").first())).toHaveValue(studio.email);

    // The same link again: already used, and the person is told they are all set.
    await page.goto(localPath(link));
    await pressConfirm(page);
    await expect(page.getByRole("heading", { name: "This link has already been used" })).toBeVisible();
    await expect(page.getByText("Your email is already confirmed, so you’re all set.")).toBeVisible();

    // A link with a typo: the friendly dead-link card with the one next step.
    await page.goto(tampered(link));
    await pressConfirm(page);
    await expect(page.getByRole("heading", { name: "This link didn’t work" })).toBeVisible();
    await expect(page.getByText(/If you already confirmed your email, you’re all set/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to sign in" })).toHaveAttribute("href", "/login");

    // A mangled link never even offers the button.
    await page.goto("/verify-email?token=abc");
    await expect(page.getByRole("heading", { name: "This link didn’t work" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm my email" })).toHaveCount(0);
    await page.goto("/verify-email");
    await expect(page.getByRole("heading", { name: "This link didn’t work" })).toBeVisible();
  } finally {
    await studio.api.dispose();
  }
});

test("signed in: a replaced link offers 'Send a new link' (with the 5-an-hour limit), and the newest link confirms and goes Home", async ({ pageWithState }) => {
  const studio = await signUpStudio("Verify signed in");
  try {
    await skipWhenEmailIsConfigured(studio);
    const page = await pageWithState(await storageFor(studio.email, studio.password));

    // Two links: the first is replaced by the second.
    const first = await devLink(studio.api);
    await devLink(studio.api);
    await page.goto(localPath(first));
    await pressConfirm(page);
    await expect(page.getByRole("heading", { name: "This link has been replaced" })).toBeVisible();
    await expect(page.getByText(`It goes to ${studio.email}.`, { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Send a new link" }).click();
    // Development: the new link is shown on the page instead of emailed.
    const dev = page.getByRole("region", { name: "Development only" }).or(page.locator('section[aria-labelledby="dev-only-link"]')).first();
    await expect(dev).toBeVisible();
    const fresh = await dev.locator("a[href*='/verify-email?token=']").getAttribute("href");
    expect(fresh).toMatch(CONFIRM_LINK_RE);

    // Two more from the API: five in the hour. The replaced link's "Send a new link" now says to wait.
    await devLink(studio.api);
    const newest = await devLink(studio.api);
    await page.goto(localPath(fresh!));
    await pressConfirm(page);
    await expect(page.getByRole("heading", { name: "This link has been replaced" })).toBeVisible();
    await page.getByRole("button", { name: "Send a new link" }).click();
    await expect(page.getByText(/You’ve asked for a lot of links in a short time\. Try again in (a minute|\d+ minutes)\./)).toBeVisible();

    // The newest link works: confirmed, and Continue goes to the owner's Home (still signed in).
    await page.goto(localPath(newest));
    await pressConfirm(page);
    await expect(page.getByRole("heading", { name: "Email confirmed" })).toBeVisible();
    await expect(page.getByText("Continue takes you to sign in.")).toHaveCount(0);
    await page.getByRole("link", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/home(\?|$)/);
    await expect(page.locator("[data-unconfirmed-email-banner]")).toHaveCount(0);

    // Back on a used link while signed in and confirmed: told straight away, before any press (UX-20); Continue goes Home.
    await page.goto(localPath(first));
    await expect(page.locator('[data-verify-state="ready_already_confirmed"]')).toContainText("that email is already confirmed. You’re all set.");
    await expect(page.getByRole("link", { name: "Continue" })).toHaveAttribute("href", "/home");
    // The press is still there, quietly, and says the same once used.
    await page.getByRole("button", { name: "Confirm this link anyway" }).click();
    await expect(page.getByRole("heading", { name: "This link has already been used" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Continue" })).toHaveAttribute("href", "/home");
  } finally {
    await studio.api.dispose();
  }
});
