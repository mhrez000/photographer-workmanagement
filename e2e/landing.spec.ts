import { newApi } from "./api";
import { UI_TEST_TIMEOUT, expect, expectFrontDoorWords, expectNoHorizontalOverflow, test } from "./fixtures";

/**
 * The landing page (front door): `GET /` is public and renders the promise in plain words — one way to
 * start ("Create your studio" → /signup) and one way in ("Sign in" → /login). A signed-in person never
 * sees it: the page sends them to their own landing page (owner / photographer → /home, editor →
 * /my-jobs, client → /portal; src/app/page.tsx + src/proxy.ts).
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

test.describe("anonymous", () => {
  test.use({ role: "anon" });

  test("GET / is a public 200 (no redirect to /login, no session needed)", async () => {
    const anon = await newApi();
    try {
      const res = await anon.pageStatus("/");
      expect(res.status, `GET / → ${res.status} ${res.location ?? ""}`).toBe(200);
    } finally {
      await anon.dispose();
    }
  });

  test("the landing page: a headline, Create your studio and Sign in, plain words, nothing sideways", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();

    // The two calls to action, found by where they go (the copy may be polished without breaking this).
    const start = page.locator('a[href^="/signup"]').first();
    const signIn = page.locator('a[href^="/login"]').first();
    await expect(start).toBeVisible();
    await expect(signIn).toBeVisible();
    // The pitch mentions the loop (shoot → editor → check → done) and never the dropped jargon.
    await expect(page.locator("body")).toContainText(/editor/i);
    await expectFrontDoorWords(page, "/");
    await expectNoHorizontalOverflow(page);
    // No staff shell on a public page.
    await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);

    // Following the calls to action.
    await start.click();
    await expect(page).toHaveURL(/\/signup/);
    await expect(page.locator("form").first()).toBeVisible();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await signIn.click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("See the demo studio opens the sign-in page with the demo accounts first", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const demo = page.getByRole("main").getByRole("link", { name: /see the demo/i });
    await expect(demo).toHaveAttribute("href", /\/login\?demo=1/);
    await demo.click();
    await expect(page).toHaveURL(/\/login\?demo=1/);
    const box = page.locator("[data-demo-accounts]");
    await expect(box).toBeVisible();
    await expect(box).toContainText(/owner/i);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/demo studio/i);
    // The hero screenshot's caption says what it is: the demo studio's Home on a busy day.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("figcaption").first()).toContainText(/demo studio/i);
  });

  test("the sign-in page links to Forgot your password and to Create your studio", async ({ page }) => {
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await expect(page.locator('a[href^="/forgot-password"]').first()).toBeVisible();
    await expect(page.locator('a[href^="/signup"]').first()).toBeVisible();
    await expectFrontDoorWords(page, "/login");
  });
});

test("signed-in people skip the landing page: owner and photographer → /home, editor → /my-jobs, client → /portal", async ({ page, api, apiAs }) => {
  expect((await api.pageStatus("/")).location, "owner").toMatch(/\/home$/);
  expect((await (await apiAs("photographer")).pageStatus("/")).location, "photographer").toMatch(/\/home$/);
  expect((await (await apiAs("editor")).pageStatus("/")).location, "editor").toMatch(/\/my-jobs$/);
  expect((await (await apiAs("client")).pageStatus("/")).location, "client").toMatch(/\/portal$/);
  // /signup and /login behave the same for a signed-in person (src/proxy.ts ENTRY_PAGES).
  expect((await api.pageStatus("/signup")).location).toMatch(/\/home$/);
  expect((await (await apiAs("editor")).pageStatus("/signup")).location).toMatch(/\/my-jobs$/);
  // In the browser.
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/home/);
});
