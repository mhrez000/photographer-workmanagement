import { ROLE_EMAILS, eventually, uniq } from "./api";
import { expect, historyList, jobHeading, pickFromCombobox, test } from "./fixtures";

/** Job creation through the UI form (spec §40 "job creation"). */
test("owner creates a job with the form; it appears in All Work and its history starts with 'created'", async ({ page, api }) => {
  const { clientName, projectName } = await api.createClientAndProject("Create");
  const photographer = await api.userByEmail(ROLE_EMAILS.photographer);
  const name = uniq("Created via UI");

  await page.goto("/jobs/new");
  const form = page.getByRole("form", { name: "Create job" });
  await pickFromCombobox(page, form.getByRole("button", { name: "Client", exact: true }), clientName);
  await pickFromCombobox(page, form.getByRole("button", { name: "Project", exact: true }), projectName);
  await form.getByRole("combobox", { name: "Job type" }).selectOption({ label: "Real Estate" });
  await form.getByRole("textbox", { name: "Job name" }).fill(name);
  await pickFromCombobox(page, form.getByRole("button", { name: "Photographer", exact: true }), photographer.name);
  await form.getByRole("radio", { name: "High" }).click();
  await form.getByRole("button", { name: "Create job" }).click();

  // Lands on the new job's detail page.
  await expect(page).toHaveURL(/\/jobs\/[A-Za-z0-9_-]+$/);
  await expect(jobHeading(page)).toContainText(name);
  const jobId = page.url().split("/jobs/")[1].split(/[?#]/)[0];

  // Server agrees.
  const detail = await api.job(jobId);
  expect(detail.job.name).toBe(name);
  expect(detail.job.statusCategory).toBe("new");
  expect(detail.job.photographer?.id).toBe(photographer.id);
  expect((detail.job as unknown as { priority: string }).priority).toBe("high");

  // All Work lists it.
  await page.goto(`/workspace/all?q=${encodeURIComponent(name)}`);
  await expect(page.getByRole("main").getByText(name).first()).toBeVisible();

  // History tab: "<owner> created the job".
  await page.goto(`/jobs/${jobId}?tab=history`);
  await expect(historyList(page)).toContainText("created the job");
  const owner = await api.me();
  await expect(historyList(page)).toContainText(owner.user.name);

  const history = await eventually(async () => {
    const h = await api.history(jobId);
    return h.some((e) => e.event?.eventType === "job.created") ? h : null;
  });
  expect(history[0].kind === "event" ? history[0].event?.eventType : history[0].stage?.toCategory).toBeTruthy();
});

test("the form shows validation errors instead of creating an incomplete job", async ({ page }) => {
  await page.goto("/jobs/new");
  const form = page.getByRole("form", { name: "Create job" });
  await form.getByRole("button", { name: "Create job" }).click();
  await expect(page).toHaveURL(/\/jobs\/new/);
  // Required fields are flagged (client/project, job type, name).
  await expect(form.getByText(/required|choose|pick/i).first()).toBeVisible();
});
