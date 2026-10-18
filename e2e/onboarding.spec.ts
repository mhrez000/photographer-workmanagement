import { loginApi, newApi, signUpStudio, uniq, uniqPassword, type ActivityItem, type Paginated } from "./api";
import { UI_TEST_TIMEOUT, expect, expectPlainWords, gotoReady, retrying, sectionNamed, storageFor, test } from "./fixtures";

/**
 * "Get set up" (front door, `GET /api/settings/onboarding`): the owner of a NEW studio sees a
 * five-step checklist on Home — Create your first job · Invite an editor · Add a client · Give a job to an
 * editor · Approve your first job. Every tick is computed from the data (never stored), so the list fills
 * in by itself as the studio does real work, and goes away once everything is done. Dismiss hides it for
 * every owner of the studio. Only admins ever see it; the demo studio (old, busy) never does.
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

const checklistOf = (page: Parameters<typeof sectionNamed>[0]) => sectionNamed(page, /^get set up$/i);

test("the checklist ticks as the studio does real work and disappears once every step is done", async ({ pageWithState }) => {
  const studio = await signUpStudio("Onboarding");
  const owner = studio.api;
  const anon = await newApi();
  try {
    const page = await pageWithState(await storageFor(studio.email, studio.password));
    await gotoReady(page, "/home", checklistOf(page));
    const checklist = checklistOf(page);
    // Five steps, in plain words, none done; the first is the obvious next step.
    await expect(checklist.getByRole("listitem")).toHaveCount(5);
    await expect(checklist.locator('[data-done="true"]')).toHaveCount(0);
    await expect(checklist).toContainText(/0\s*\/\s*5/);
    await expect(checklist.locator('[aria-current="step"]')).toContainText(/create your first job/i);
    await expect(checklist.getByRole("link", { name: /create your first job/i })).toHaveAttribute("href", "/jobs/new");
    await expect(checklist.getByRole("link", { name: /invite an editor/i })).toHaveAttribute("href", /\/settings\/people\?invite=editor/);
    await expectPlainWords(page, "/home");
    // A brand-new studio: a welcome instead of "N to check".
    await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toContainText(/welcome/i);

    // Steps 1 + 3: the first job (which brings the first client with it).
    const job = await owner.createJob({ name: uniq("E2E onboarding job") });
    expect((await owner.onboarding())?.steps).toMatchObject({ createdFirstJob: true, addedClient: true, invitedEditor: false, assignedEditor: false, approvedFirst: false });
    await page.reload();
    await expect(checklist).toContainText(/2\s*\/\s*5/);
    await expect(checklist.locator('[data-step="createdFirstJob"]')).toHaveAttribute("data-done", "true");
    await expect(checklist.locator('[data-step="addedClient"]')).toHaveAttribute("data-done", "true");
    await expect(checklist.locator('[aria-current="step"]')).toContainText(/invite an editor/i);
    // Home now has its normal sections too (the studio has a job).
    await expect(page.getByRole("main").getByRole("heading", { level: 1 })).not.toContainText(/welcome/i);

    // Step 2: inviting an editor counts the moment the link is made (they need not have joined yet).
    const invite = await owner.inviteByLink("editor", "Onboarding");
    expect((await owner.onboarding())?.steps.invitedEditor).toBe(true);
    // Step 4: give the job to that editor.
    await owner.assignEditor(job.id, invite.user.id);
    const four = await owner.onboarding();
    expect(four).toMatchObject({ completed: 4, show: true });
    expect(four?.steps.assignedEditor).toBe(true);
    await page.reload();
    await expect(checklist).toContainText(/4\s*\/\s*5/);
    await expect(checklist.locator('[data-done="true"]')).toHaveCount(4);
    await expect(checklist.locator('[aria-current="step"]')).toContainText(/approve your first job/i);

    // Step 5: the editor joins, sends it for checking; the owner approves.
    const password = uniqPassword();
    expect((await anon.acceptInvite(invite.token, password)).status).toBe(200);
    await anon.sendForChecking(job.id);
    await owner.approve(job.id, "n/a");
    const done = await owner.onboarding();
    expect(done).toMatchObject({ completed: 5, show: false, dismissed: false });
    await page.reload();
    await expect(page.getByRole("main").getByRole("heading", { name: /^get set up$/i })).toHaveCount(0);
    await expect(page.getByRole("main")).toContainText(/needs attention|coming up|ready to check/i);
  } finally {
    await anon.dispose();
    await owner.dispose();
  }
});

test("Dismiss hides the checklist for every owner of the studio and it does not come back", async ({ pageWithState }) => {
  const studio = await signUpStudio("Onboarding dismiss");
  const owner = studio.api;
  try {
    const page = await pageWithState(await storageFor(studio.email, studio.password));
    await gotoReady(page, "/home", checklistOf(page));
    const checklist = checklistOf(page);
    const dismiss = checklist.getByRole("button", { name: /^dismiss/i }).first();
    await retrying(async () => {
      if (!((await owner.onboarding())?.dismissed ?? false)) await dismiss.click({ timeout: 5_000 });
      await expect.poll(async () => (await owner.onboarding())?.dismissed, { timeout: 8_000 }).toBe(true);
    });
    await expect(checklist).toBeHidden();
    await page.reload();
    await expect(page.getByRole("main").getByRole("heading", { name: /^get set up$/i })).toHaveCount(0);
    expect(await owner.onboarding()).toMatchObject({ dismissed: true, show: false });
    expect((await owner.onboarding())?.dismissedAt).toBeTruthy();
    // Idempotent, and audited as a studio setting.
    expect((await owner.dismissOnboarding()).changed).toBe(false);
    const feed = await owner.get<Paginated<ActivityItem>>("/api/activity?limit=50&eventType=settings.updated");
    expect(JSON.stringify(feed)).toContain("onboardingDismissedAt");
    // A co-owner invited later does not see it either; an editor never does and may not dismiss.
    const co = await owner.inviteUser("photographer", { label: "Onboarding co-owner", preset: "co_owner" });
    const coSession = await loginApi(co.email, co.tempPassword);
    expect(await coSession.onboarding()).toMatchObject({ dismissed: true, show: false });
    await coSession.dispose();
    const editor = await owner.inviteUser("editor", "Onboarding editor");
    const editorSession = await loginApi(editor.email, editor.tempPassword);
    expect(await editorSession.onboarding()).toBeNull();
    expect((await editorSession.raw("POST", "/api/settings/onboarding/dismiss")).status).toBe(403);
    await editorSession.dispose();
  } finally {
    await owner.dispose();
  }
});

test("the demo studio never shows the checklist (not new), and an extra photographer gets nothing", async ({ page, api, apiAs }) => {
  const state = await api.onboarding();
  expect(state?.show).toBe(false);
  expect(state?.isNewStudio).toBe(false);
  await gotoReady(page, "/home", page.getByRole("main").getByRole("heading", { level: 1 }));
  await expect(page.getByRole("main").getByRole("heading", { name: /^get set up$/i })).toHaveCount(0);
  const photographer = await apiAs("photographer");
  expect(await photographer.onboarding()).toBeNull();
  const editor = await apiAs("editor");
  expect(await editor.onboarding()).toBeNull();
  const client = await apiAs("client");
  expect([403, 404]).toContain((await client.raw("GET", "/api/settings/onboarding")).status);
});
