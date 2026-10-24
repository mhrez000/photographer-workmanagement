import { localPath, newApi } from "./api";
import { UI_TEST_TIMEOUT, expect, publicForm, test } from "./fixtures";

/**
 * "Continue with Google" (accounts, docs/ACCOUNTS.md §8 B) on a server WITHOUT Google configured (no
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — the shared dev server and CI): every Google button is hidden, the Google
 * routes answer with a friendly redirect or a plain JSON error (never a 500), and the /signup/google finish page
 * without its signed cookie offers a calm "start again". The configured flows (PKCE, id_token checks, linking,
 * invites, connect / disconnect, finishing a sign-up) are covered without Google in
 * src/server/services/googleAuth.test.ts and src/server/auth/google-oidc.test.ts.
 */

test.use({ role: "anon" });
test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

const googleUi = '[data-google-button], [data-continue-with-google], [data-google-card]';

test("no Google buttons on sign-in, sign-up or an invite while Google isn't configured", async ({ page, api }) => {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await expect(publicForm(page)).toBeVisible();
  await expect(page.locator(googleUi)).toHaveCount(0);
  await expect(page.getByText(/continue with google/i)).toHaveCount(0);

  await page.goto("/signup", { waitUntil: "domcontentloaded" });
  await expect(publicForm(page)).toBeVisible();
  await expect(page.locator(googleUi)).toHaveCount(0);

  const invite = await api.inviteByLink("editor", "Google hidden");
  await page.goto(localPath(invite.inviteUrl), { waitUntil: "domcontentloaded" });
  await expect(publicForm(page)).toBeVisible();
  await expect(page.locator(googleUi)).toHaveCount(0);
  // The lede only offers what exists: a password.
  await expect(page.getByText("Choose a password to get started.")).toBeVisible();
  await expect(page.getByText(/or continue with google/i)).toHaveCount(0);
});

test("GET /api/auth/google/start without Google → a friendly redirect back to the page, never a 500", async ({ page }) => {
  const anon = await newApi();
  try {
    const signin = await anon.pageStatus("/api/auth/google/start?intent=signin&next=/jobs");
    expect(signin.status).toBe(302);
    expect(new URL(signin.location ?? "", "http://x").pathname + new URL(signin.location ?? "", "http://x").search).toBe("/login?google=disabled&next=%2Fjobs");
    const signup = await anon.pageStatus("/api/auth/google/start?intent=signup");
    expect(signup.status).toBe(302);
    expect(signup.location).toContain("/signup?google=disabled");
    // A bad query is a redirect too.
    expect((await anon.pageStatus("/api/auth/google/start?intent=nonsense")).status).toBe(302);
    // The callback with no round trip behind it also lands on sign-in.
    const callback = await anon.pageStatus("/api/auth/google/callback?code=abc&state=def");
    expect(callback.status).toBe(302);
    expect(callback.location).toContain("/login?google=disabled");
    expect((await anon.pageStatus("/api/auth/google/callback?error=access_denied")).status).toBe(302);
  } finally {
    await anon.dispose();
  }

  // Following it: the sign-in page explains in plain words, and the form still works.
  const res = await page.goto("/api/auth/google/start?intent=signin", { waitUntil: "domcontentloaded" });
  expect(res?.status()).toBe(200);
  await expect(page).toHaveURL(/\/login\?google=disabled/);
  await expect(page.getByText("Continue with Google isn’t available right now. Use your email and password instead.")).toBeVisible();
  await expect(publicForm(page)).toBeVisible();
  await expect(page.locator("[data-google-button]")).toHaveCount(0);

  await page.goto("/api/auth/google/start?intent=signup", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/signup\?google=disabled/);
  await expect(page.getByText(/isn’t available right now\. Fill in the form instead\./)).toBeVisible();
});

test("/signup/google without its signed cookie: a calm answer and the one way forward, back to Create your studio", async ({ page, context }) => {
  const res = await page.goto("/signup/google?from=signin", { waitUntil: "domcontentloaded" });
  expect(res?.status()).toBe(200);
  const card = page.locator("[data-google-start-again]");
  await expect(card).toBeVisible();
  // Google sign-in is off on this server (UX-15): never "press Continue with Google again" — sign up with an email.
  await expect(card.getByRole("heading", { name: "Signing up with Google isn’t available" })).toBeVisible();
  await expect(card).not.toContainText(/press Continue with Google again/i);
  await expect(card.getByText(/Nothing was created/)).toBeVisible();
  // No half-finished form, no Google identity, no stack trace.
  await expect(page.locator("form")).toHaveCount(0);
  await expect(page.getByText(/no proofline account for/i)).toHaveCount(0);

  // A forged / garbage finish cookie reads the same.
  await context.addCookies([{ name: "pl_google_signup", value: "eyJhbGciOiJIUzI1NiJ9.e30.forged", url: new URL("/", page.url()).toString() }]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-google-start-again]")).toBeVisible();

  await card.getByRole("link", { name: "Create your studio" }).click();
  await expect(page).toHaveURL(/\/signup$/);
  await expect(publicForm(page)).toBeVisible();
});

test("API contract: finishing without the cookie is a plain 400; disconnect is self-service; other methods are 405", async ({ api }) => {
  const anon = await newApi();
  try {
    const complete = await anon.raw("POST", "/api/auth/google/complete", { studioName: "Never Created Studio" });
    expect(complete.status).toBe(400);
    expect(complete.error).toMatchObject({ code: "validation", message: "Start again with Continue with Google", details: { reason: "google_signup_expired" } });
    // Signed out: disconnect needs a session.
    expect((await anon.raw("POST", "/api/auth/google/disconnect")).status).toBe(401);
    for (const [method, url] of [
      ["GET", "/api/auth/google/complete"],
      ["GET", "/api/auth/google/disconnect"],
      ["POST", "/api/auth/google/start"],
      ["POST", "/api/auth/google/callback"],
    ] as const) {
      const r = await anon.raw(method, url, method === "POST" ? {} : undefined);
      expect(r.status, `${method} ${url}`).toBe(405);
      expect(r.error?.code).toBe("method_not_allowed");
    }
  } finally {
    await anon.dispose();
  }
  // Signed in, nothing connected: a quiet no-op.
  expect(await api.post("/api/auth/google/disconnect")).toEqual({ ok: true, disconnected: false });
});

test.describe("signed in", () => {
  test.use({ role: "owner" });

  test("My account has no Google card while Google is off and nothing is connected", async ({ page }) => {
    await page.goto("/settings/account", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "My account" })).toBeVisible();
    await expect(page.locator("[data-google-card]")).toHaveCount(0);
    await expect(page.locator("[data-google-button]")).toHaveCount(0);
  });
});
