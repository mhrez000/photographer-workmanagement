import { newApi } from "./api";
import { UI_TEST_TIMEOUT, expect, expectFrontDoorWords, expectNoHorizontalOverflow, test } from "./fixtures";

/**
 * The landing page (front door): `GET /` is public and renders the promise in plain words — one way to
 * start ("Create your studio" → /signup) and one way in ("Sign in" → /login). Accounts (docs/ACCOUNTS.md §1):
 * a signed-in person sees it too (no redirect, no portal bounce) and the header swaps the two buttons for one way
 * back home in words that fit them (UX-11): "Go to your studio" (owner / photographer → /home), "Go to my jobs"
 * (editor → /my-jobs), "See your work" (client → /portal); the footer and the FAQ follow (UX-21). "See the demo
 * studio" (→ /login?demo=1, the "Look around the demo" panel) is only offered where this deployment has an OPEN demo
 * studio (UX-07) — the e2e studio is NOT one (SEED_DEMO=off), so here the landing page offers no demo at all, and a
 * stale /login?demo=1 link says so plainly. Never a demo email or password anywhere.
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

  test("See the demo studio (only where the demo is open) opens /login?demo=1: the demo panel first, or a plain note; never a password", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const demoLinks = page.getByRole("main").getByRole("link", { name: /see the demo/i });
    const offered = (await demoLinks.count()) > 0;
    if (offered) {
      // Every demo link goes to the demo-first sign-in page (the FAQ's too).
      for (const link of await demoLinks.all()) await expect(link).toHaveAttribute("href", /\/login\?demo=1/);
      await demoLinks.first().click();
      await expect(page).toHaveURL(/\/login\?demo=1/);
    } else {
      // UX-07: no dead end advertised — and a stale link still lands on a plain note.
      await page.goto("/login?demo=1", { waitUntil: "domcontentloaded" });
    }
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const panel = page.locator("[data-demo-panel]");
    expect((await panel.count()) > 0, "the landing page offers the demo exactly when the sign-in page has it").toBe(offered);
    if ((await panel.count()) > 0) {
      // A deployment with a demo studio: first, highlighted, one button per persona.
      await expect(panel).toHaveAttribute("data-highlighted", "");
      await expect(page.getByRole("heading", { level: 1 })).toContainText(/demo studio/i);
      for (const who of ["Owner", "Photographer", "Editor", "Client"]) await expect(panel.getByRole("button", { name: new RegExp(`look around as ${who}`, "i") })).toBeVisible();
    } else {
      // The e2e studio is not a demo studio: the page says so plainly and the sign-in form is right there.
      await expect(page.getByRole("heading", { level: 1 })).toContainText(/sign in/i);
      await expect(page.getByText(/demo studio isn.t open right now/i)).toBeVisible();
      await expect(page.locator('input[type="password"]')).toHaveCount(1);
    }
    // The old demo-accounts box is gone: no seeded emails, no shared password.
    await expect(page.locator("[data-demo-accounts]")).toHaveCount(0);
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/@studio\.test|Password123!/);
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

test("signed-in people see the landing page too, with one button back to their own home in words that fit them", async ({ page, api, apiAs, pageAs }) => {
  // No redirect for anyone (the proxy no longer bounces a client to the portal either).
  for (const [who, client] of [["owner", api], ["photographer", await apiAs("photographer")], ["editor", await apiAs("editor")], ["client", await apiAs("client")]] as const) {
    const res = await client.pageStatus("/");
    expect(res.status, `${who}: GET / → ${res.status} ${res.location ?? ""}`).toBe(200);
  }
  // In the browser, as the owner: the landing page, its header offering the way back (and no Sign in / Create).
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  const header = page.getByRole("banner");
  const back = header.getByRole("link", { name: /go to your studio/i });
  await expect(back).toBeVisible();
  await expect(back).toHaveAttribute("href", "/home");
  await expect(header.locator('a[href^="/login"]')).toHaveCount(0);
  await expect(header.locator('a[href^="/signup"]')).toHaveCount(0);
  // The hero offers the same way back: no "Create your studio" / "Sign in" / demo for someone already signed in.
  const hero = page.locator('section[aria-labelledby="hero-heading"]');
  await expect(hero.getByRole("link", { name: /go to your studio/i })).toHaveAttribute("href", "/home");
  await expect(hero.locator('a[href^="/login"], a[href^="/signup"]')).toHaveCount(0);
  // UX-21: the footer and the FAQ follow — no Sign in / Create your studio for someone already in.
  const footer = page.getByRole("contentinfo");
  await expect(footer.getByRole("link", { name: /go to your studio/i })).toHaveAttribute("href", "/home");
  await expect(footer.locator('a[href^="/login"], a[href^="/signup"]')).toHaveCount(0);
  await expect(page.locator("#faq").locator('a[href^="/login"], a[href^="/signup"]')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await back.click();
  await expect(page).toHaveURL(/\/home/);
  // Each persona's button goes to their own home, in their own words (UX-11).
  for (const [role, home, label] of [["editor", "/my-jobs", "Go to my jobs"], ["client", "/portal", "See your work"]] as const) {
    const p = await pageAs(role);
    await p.goto("/", { waitUntil: "domcontentloaded" });
    await expect(p.getByRole("banner").getByRole("link", { name: label }), role).toHaveAttribute("href", home);
  }
});
