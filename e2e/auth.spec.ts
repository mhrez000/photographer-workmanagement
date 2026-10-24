import type { Page } from "@playwright/test";
import { BASE_URL, loginApi, type InvitedUser } from "./api";
import { expect, storageFor, test } from "./fixtures";

/**
 * Auth: login success / failure, logout, protected-route redirect, and a deactivated user's live
 * session turning into 401s. Signing in lands each persona on its own home (plan §3): editors on
 * My jobs, photographers on Home. Every test signs in as a user it invites, so no seeded account is
 * ever logged out.
 */
test.use({ role: "anon" });

async function signInThroughForm(page: Page, email: string, password: string) {
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

const accountMenu = (page: Page, user: InvitedUser) => page.getByRole("button", { name: `Account menu for ${user.user.name}` });

test("the login page never shows demo emails or passwords; the demo panel (one button per persona) only where a demo studio exists", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/sign in/i);
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/@studio\.test|Password123!/);
  await expect(page.locator("[data-demo-accounts]")).toHaveCount(0);
  const panel = page.locator("[data-demo-panel]");
  // The e2e studio is not a demo studio (SEED_DEMO=off): no panel. A demo deployment shows the four personas.
  if ((await panel.count()) > 0) {
    for (const label of ["Owner", "Photographer", "Editor", "Client"]) await expect(panel.getByRole("button", { name: new RegExp(`look around as ${label}`, "i") }), label).toBeVisible();
  }
  await expect(page.getByText(/manager|team member|workloads/i)).toHaveCount(0);
});

test("an editor signs in and lands on My jobs; a photographer lands on Home", async ({ page, api, pageWithState }) => {
  const editor = await api.inviteUser("editor", "Auth ok");
  await page.goto("/login");
  await signInThroughForm(page, editor.email, editor.tempPassword);
  await expect(page).toHaveURL(/\/my-jobs/, { timeout: 20_000 });
  await expect(accountMenu(page, editor)).toBeVisible();

  const photographer = await api.inviteUser("photographer", { label: "Auth home", preset: "own_shoots" });
  const p = await pageWithState(undefined);
  await p.goto("/login");
  await signInThroughForm(p, photographer.email, photographer.tempPassword);
  await expect(p).toHaveURL(/\/home/, { timeout: 20_000 });
  await expect(accountMenu(p, photographer)).toBeVisible();
});

test("login fails with a wrong password and stays on /login with an error", async ({ page, api }) => {
  const user = await api.inviteUser("editor", "Auth bad");
  await page.goto("/login");
  await signInThroughForm(page, user.email, "definitely-wrong-1");

  await expect(page.getByRole("alert").filter({ hasText: /incorrect email or password/i })).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  expect((await page.context().cookies()).find((c) => c.name === "pwm_session")).toBeUndefined();

  // The API agrees: 401 with the generic message (no account enumeration).
  const res = await page.request.post("/api/auth/login", {
    data: { email: user.email, password: "definitely-wrong-2" },
    headers: { Origin: BASE_URL },
  });
  expect(res.status()).toBe(401);
  expect((await res.json()).error.code).toBe("unauthorized");
});

test("an unauthenticated visit to a protected route redirects to /login?next= and returns there after sign-in", async ({ page, api }) => {
  const user = await api.inviteUser("photographer", { label: "Auth next", preset: "own_shoots" });

  await page.goto("/jobs");
  await expect(page).toHaveURL(/\/login\?next=%2Fjobs/);

  // Unauthenticated API calls are a JSON 401, not a redirect.
  const res = await page.request.get("/api/jobs");
  expect(res.status()).toBe(401);
  expect((await res.json()).error.code).toBe("unauthorized");

  await signInThroughForm(page, user.email, user.tempPassword);
  await expect(page).toHaveURL(/\/jobs/);
});

test("logout ends the session: protected pages redirect to /login afterwards", async ({ api, pageWithState }) => {
  const user = await api.inviteUser("editor", "Auth logout");
  const page = await pageWithState(await storageFor(user.email, user.tempPassword));

  await page.goto("/my-jobs");
  await accountMenu(page, user).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();

  await expect(page).toHaveURL(/\/login\?logged_out=1/);
  // UX-19: a quiet line says so.
  await expect(page.getByText("You’re logged out.")).toBeVisible();
  expect((await page.context().cookies()).find((c) => c.name === "pwm_session" && c.value)).toBeUndefined();

  await page.goto("/my-jobs");
  await expect(page).toHaveURL(/\/login/);
});

test("a deactivated user's live session gets 401 from the API and is bounced from pages", async ({ api, pageWithState }) => {
  const user = await api.inviteUser("editor", "Auth deactivated");
  const session = await loginApi(user.email, user.tempPassword);
  const page = await pageWithState(await storageFor(user.email, user.tempPassword));

  expect((await session.raw("GET", "/api/auth/me")).status).toBe(200);

  await api.post(`/api/users/${user.user.id}/deactivate`, { expectedVersion: user.user.version, reason: "E2E deactivation test" });

  for (const path of ["/api/auth/me", "/api/jobs", "/api/notifications"]) {
    const res = await session.raw("GET", path);
    expect(res.status, path).toBe(401);
    expect(res.error?.code).toBe("unauthorized");
  }

  // A browser holding the old cookie is sent to /login?expired=1.
  await page.goto("/my-jobs");
  await expect(page).toHaveURL(/\/login\?expired=1/);
  // UX-05: plain words, no "session".
  await expect(page.getByText("You’ve been logged out on this device. Sign in again to carry on.")).toBeVisible();

  // And they cannot sign in again.
  const relogin = await page.request.post("/api/auth/login", {
    data: { email: user.email, password: user.tempPassword },
    headers: { Origin: BASE_URL },
  });
  expect(relogin.status()).toBe(401);
  await session.dispose();
});
