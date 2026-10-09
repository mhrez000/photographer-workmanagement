import type { Page } from "@playwright/test";
import { BASE_URL, loginApi, type InvitedUser } from "./api";
import { expect, storageFor, test } from "./fixtures";

/**
 * §40 auth: login success / failure, logout, protected-route redirect, and a
 * deactivated user's live session turning into 401s. Every test signs in as
 * a user it invites, so no seeded account is ever logged out.
 */
test.use({ role: "anon" });

async function signInThroughForm(page: Page, email: string, password: string) {
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

const accountMenu = (page: Page, user: InvitedUser) => page.getByRole("button", { name: `Account menu for ${user.user.name}` });

test("login succeeds with valid credentials and lands on the dashboard", async ({ page, api }) => {
  const user = await api.inviteUser("editor", "Auth ok");
  await page.goto("/login");
  await signInThroughForm(page, user.email, user.tempPassword);

  await expect(page).toHaveURL(/\/dashboard/);
  await expect(accountMenu(page, user)).toBeVisible();
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
  const user = await api.inviteUser("editor", "Auth next");

  await page.goto("/workspace/kanban");
  await expect(page).toHaveURL(/\/login\?next=%2Fworkspace%2Fkanban/);

  // Unauthenticated API calls are a JSON 401, not a redirect.
  const res = await page.request.get("/api/jobs");
  expect(res.status()).toBe(401);
  expect((await res.json()).error.code).toBe("unauthorized");

  await signInThroughForm(page, user.email, user.tempPassword);
  await expect(page).toHaveURL(/\/workspace\/kanban/);
});

test("logout ends the session: protected pages redirect to /login afterwards", async ({ api, pageWithState }) => {
  const user = await api.inviteUser("editor", "Auth logout");
  const page = await pageWithState(await storageFor(user.email, user.tempPassword));

  await page.goto("/dashboard");
  await accountMenu(page, user).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();

  await expect(page).toHaveURL(/\/login/);
  expect((await page.context().cookies()).find((c) => c.name === "pwm_session" && c.value)).toBeUndefined();

  await page.goto("/workspace/my");
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
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login\?expired=1/);
  await expect(page.getByText(/your session ended/i)).toBeVisible();

  // And they cannot sign in again.
  const relogin = await page.request.post("/api/auth/login", {
    data: { email: user.email, password: user.tempPassword },
    headers: { Origin: BASE_URL },
  });
  expect(relogin.status()).toBe(401);
  await session.dispose();
});
