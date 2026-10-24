import { EMAIL_TAKEN_MESSAGE, PASSWORD_TOO_SHORT_MESSAGE, fieldErrorsOf, newApi, signUpStudio, uniqPassword, type UserProfile } from "./api";
import { UI_TEST_TIMEOUT, emailBox, expect, expectPlainWords, fillPasswords, publicForm, sectionNamed, sessionCookie, submitButton, test } from "./fixtures";

/**
 * "Create your studio" (front door, `POST /api/auth/signup`): one form — your name, email, password,
 * studio name — creates the organisation, its owner (admin, primary owner), the five stages and the
 * usual types of shoot in ONE go and signs the owner in, landing them on /home with the "Get set up"
 * checklist. A taken email (any studio, any role) gets the one generic message; a weak password is
 * caught inline; nothing is created on a failed attempt.
 *
 * Every test creates its own studio with a unique email, so nothing here touches the shared demo.
 */

test.use({ role: "anon" });
test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test("API contract: one studio, one owner, signed in; a taken email and a weak password are 400 field errors", async () => {
  const studio = await signUpStudio("Signup api");
  const anon = await newApi();
  try {
    // The owner: admin, primary owner, a photographer who sees everything, Advanced tools off.
    const me = await studio.api.me();
    expect(me.user).toMatchObject({ email: studio.email, name: studio.ownerName, role: "photographer", persona: "admin", isAdmin: true, isPrimaryOwner: true, canViewAllJobs: true, canCreateJobs: true });
    expect(me.settings?.advancedToolsEnabled ?? false).toBe(false);
    const settings = await studio.api.settings();
    expect(settings.organisation.name).toBe(studio.studioName);
    expect(settings.organisation.slug).toBe(studio.slug);
    // The studio is ready to work: types of shoot exist, nobody else is in it, no jobs yet.
    const types = await studio.api.get<{ id: string; name: string }[]>("/api/job-types");
    expect(types.length).toBeGreaterThan(0);
    const users = await studio.api.get<UserProfile[]>("/api/users");
    expect(users.map((u) => u.email)).toEqual([studio.email]);
    expect((await studio.api.jobsMatching("")).length).toBe(0);
    // The first-run checklist starts empty and is shown.
    expect(await studio.api.onboarding()).toMatchObject({ completed: 0, total: 5, dismissed: false, isNewStudio: true, show: true, jobCount: 0 });
    // The studio's history records the sign-up (and never a password).
    const feed = await studio.api.get<{ items: { eventType: string }[] }>("/api/activity?limit=50");
    expect(feed.items.map((e) => e.eventType)).toEqual(expect.arrayContaining(["org.created", "user.created"]));
    expect(JSON.stringify(feed)).not.toContain(studio.password);

    // A taken email: the one generic message, whichever studio or role owns it. Fresh people only: sign-up
    // attempts are counted per address (SEC-04), so probing the seeded logins on every run would use up their budget.
    const editor = await studio.api.inviteUser("editor", "Signup taken");
    const { clientId } = await studio.api.createClient("Signup taken", { portal: true });
    const client = await studio.api.inviteUser("client", { label: "Signup taken", clientId });
    for (const taken of [studio.email, editor.email, client.email, studio.email.toUpperCase()]) {
      const dup = await anon.signup({ ownerName: "Someone Else", email: taken, password: uniqPassword(), studioName: `Another Studio ${stamp()}` });
      expect(dup.status, taken).toBe(400);
      expect(dup.error?.code, taken).toBe("validation");
      expect(fieldErrorsOf(dup).email, taken).toEqual([EMAIL_TAKEN_MESSAGE]);
    }
    // A weak password, a missing studio name: inline field errors, nothing created, nobody signed in.
    const weak = await anon.signup({ ownerName: "Someone Else", email: `e2e-weak-${stamp()}@example.test`, password: "short", studioName: `Weak Studio ${stamp()}` });
    expect(weak.status).toBe(400);
    expect(fieldErrorsOf(weak).password?.[0]).toBe(PASSWORD_TOO_SHORT_MESSAGE);
    const noStudio = await anon.signup({ ownerName: "Someone Else", email: `e2e-nostudio-${stamp()}@example.test`, password: uniqPassword(), studioName: "" });
    expect(noStudio.status).toBe(400);
    expect(fieldErrorsOf(noStudio).studioName?.length ?? 0).toBeGreaterThan(0);
    expect((await anon.raw("GET", "/api/auth/me")).status).toBe(401);
    // Only POST exists.
    expect((await anon.raw("GET", "/api/auth/signup")).status).toBe(405);
  } finally {
    await anon.dispose();
    await studio.api.dispose();
  }
});

test("Create your studio: the form lands on /home with the Get set up checklist, signed in as the owner", async ({ page }) => {
  const s = stamp();
  const ownerName = `E2E Signup Owner ${s}`;
  const email = `e2e-signup-ui-${s}@example.test`;
  const studioName = `E2E Signup Studio ${s}`;
  const password = uniqPassword();

  await page.goto("/signup", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: /create your studio/i })).toBeVisible();
  const form = publicForm(page);
  await expect(form).toBeVisible();
  await form.getByRole("textbox", { name: /^your name/i }).fill(ownerName);
  await emailBox(form).fill(email);
  await fillPasswords(form, password);
  await form.getByRole("textbox", { name: /^studio name/i }).fill(studioName);
  await submitButton(form).click();

  await expect(page).toHaveURL(/\/home/, { timeout: 60_000 });
  await expect(page.getByRole("banner").getByRole("button", { name: `Account menu for ${ownerName}` })).toBeVisible();
  // A brand-new studio: a welcome and the checklist front and centre, in plain words.
  const checklist = sectionNamed(page, /^get set up$/i);
  await expect(checklist).toBeVisible();
  await expect(checklist.getByRole("listitem")).toHaveCount(5);
  await expect(checklist).toContainText(/create your first job/i);
  await expect(checklist).toContainText(/invite an editor/i);
  await expect(checklist).toContainText(/0\s*\/\s*5/);
  await expect(page.getByRole("main").getByRole("link", { name: /create your first job/i }).first()).toBeVisible();
  // A studio created after the simplification never saw the old screens: no "got simpler" card, one Dismiss.
  await expect(page.getByText(/proofline got simpler/i)).toHaveCount(0);
  await expect(checklist.getByRole("button", { name: /dismiss/i })).toHaveCount(1);
  await expectPlainWords(page, "/home");
  // Signed in, the sign-in and sign-up pages say who you are instead of showing a form (docs/ACCOUNTS.md §1).
  for (const path of ["/login", "/signup"]) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    const notice = page.locator("[data-signed-in-notice]");
    await expect(notice.getByRole("heading", { name: ownerName }), path).toBeVisible();
    await expect(notice.getByRole("link", { name: /go to your studio/i }), path).toHaveAttribute("href", "/home");
    await expect(page.locator('input[type="password"]'), path).toHaveCount(0);
  }
  // The sign-in page on THIS browser (a real studio was created here) never offers the demo panel...
  await page.context().clearCookies({ name: "pwm_session" });
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await expect(page.locator('input[type="password"]')).toHaveCount(1);
  await expect(page.locator("[data-demo-panel]")).toHaveCount(0);
  // ...unless they ask for the demo on purpose — where this deployment has a demo studio (the e2e one is not).
  await page.goto("/login?demo=1", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  if ((await page.locator("[data-demo-panel]").count()) === 0) await expect(page.getByText(/demo studio isn.t open right now/i)).toBeVisible();
  else await expect(page.locator("[data-demo-panel]")).toBeVisible();
  // The Help page has no "old bookmarks" paragraph for a studio that never had them.
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await emailBox(publicForm(page)).fill(email);
  await publicForm(page).locator('input[type="password"]').fill(password);
  await submitButton(publicForm(page)).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 60_000 });
  await page.goto("/help", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: /where things are/i })).toBeVisible();
  await expect(page.locator("[data-old-bookmarks]")).toHaveCount(0);
  await expect(page.getByText(/old bookmarks/i)).toHaveCount(0);

  // The session is the new owner's, in the new studio.
  const me = (await (await page.request.get("/api/auth/me")).json()) as { data: { user: { email: string; isPrimaryOwner: boolean } } };
  expect(me.data.user).toMatchObject({ email, isPrimaryOwner: true });
  const settings = (await (await page.request.get("/api/settings")).json()) as { data: { organisation: { name: string } } };
  expect(settings.data.organisation.name).toBe(studioName);
});

test("API contract: a taken email and a short password come back in the ONE 400", async () => {
  // A fresh taken address each run: the "is it taken?" answer counts toward that address's sign-up limit (SEC-04),
  // so a fixed seeded address would run out after a few runs within the hour.
  const studio = await signUpStudio("Both");
  const anon = await newApi();
  try {
    const both = await anon.signup({ ownerName: "Someone", email: studio.email, password: "short", studioName: `Both ${stamp()}` });
    expect(both.status).toBe(400);
    expect(fieldErrorsOf(both).email?.[0]).toBe(EMAIL_TAKEN_MESSAGE);
    expect(fieldErrorsOf(both).password?.[0]).toBe(PASSWORD_TOO_SHORT_MESSAGE);
  } finally {
    await anon.dispose();
    await studio.api.dispose();
  }
});

test("a taken email shows the one generic message inline, offers Sign in, and signs nobody in", async ({ page }) => {
  const studio = await signUpStudio("Signup dup");
  try {
    await page.goto("/signup", { waitUntil: "domcontentloaded" });
    const form = publicForm(page);
    await form.getByRole("textbox", { name: /^your name/i }).fill("Someone Else");
    await emailBox(form).fill(studio.email);
    await fillPasswords(form, uniqPassword());
    await form.getByRole("textbox", { name: /^studio name/i }).fill(`Another Studio ${stamp()}`);
    await submitButton(form).click();

    await expect(page.getByRole("alert").filter({ hasText: EMAIL_TAKEN_MESSAGE })).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/signup/);
    expect(await sessionCookie(page)).toBeUndefined();
    // The way out is right there: sign in (with the email carried over).
    const signIn = page.locator('a[href^="/login"]').first();
    await expect(signIn).toBeVisible();
    // What was typed stays (no retyping the whole form).
    await expect(emailBox(form)).toHaveValue(studio.email);
  } finally {
    await studio.api.dispose();
  }
});

test("a weak password is caught inline before any round trip; nothing is created and the form keeps what was typed", async ({ page }) => {
  const s = stamp();
  const email = `e2e-signup-weak-${s}@example.test`;
  await page.goto("/signup", { waitUntil: "domcontentloaded" });
  const form = publicForm(page);
  await form.getByRole("textbox", { name: /^your name/i }).fill(`E2E Weak ${s}`);
  await emailBox(form).fill(email);
  await fillPasswords(form, "short1");
  await form.getByRole("textbox", { name: /^studio name/i }).fill(`E2E Weak Studio ${s}`);
  // The rule is enforced client-side: the live hint says how many characters are missing and the button
  // stays disabled (no 400 round trip for a known failure). Enter does nothing either.
  await expect(form.getByText(/4 more characters to go/i)).toBeVisible();
  await expect(submitButton(form)).toBeDisabled();
  await form.locator('input[type="password"]').first().press("Enter");
  await expect(page).toHaveURL(/\/signup/);
  expect(await sessionCookie(page)).toBeUndefined();
  await expect(emailBox(form)).toHaveValue(email);
  // Typing enough re-enables it at once.
  await fillPasswords(form, "short1-but-long-enough");
  await expect(submitButton(form)).toBeEnabled();
  // The email is still free: the same address signs up fine once the password is long enough.
  const anon = await newApi();
  try {
    const ok = await anon.signup({ ownerName: `E2E Weak ${s}`, email, password: uniqPassword(), studioName: `E2E Weak Studio ${s}` });
    expect(ok.status, JSON.stringify(ok.error)).toBe(200);
    expect(ok.data.redirectTo).toBe("/home");
  } finally {
    await anon.dispose();
  }
});
