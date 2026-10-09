import { ROLE_EMAILS, civilDate, uniq } from "./api";
import { expect, test } from "./fixtures";

/** Calendar + timeline (spec §40 "calendar"; ARCHITECTURE §10). */

test("calendar renders the job's deadline and switches between month, week and day", async ({ page, api }) => {
  const name = uniq("Calendar");
  const job = await api.createJob({ name, dueDate: civilDate(0) });

  await page.goto(`/workspace/calendar?q=${encodeURIComponent(name)}`);
  const views = page.getByRole("radiogroup", { name: "Calendar view" });
  await expect(views.getByRole("radio", { name: "Month" })).toBeChecked();
  const event = page.getByRole("button", { name: new RegExp(job.jobNumber) });
  await expect(event.first()).toBeVisible();

  for (const view of ["Week", "Day", "Month"] as const) {
    await views.getByRole("radio", { name: view }).click();
    await expect(views.getByRole("radio", { name: view })).toBeChecked();
    // Due today → visible in every view.
    await expect(page.getByRole("button", { name: new RegExp(job.jobNumber) }).first()).toBeVisible();
  }

  // The API agrees.
  const from = civilDate(-1);
  const to = civilDate(1);
  const events = await api.get<{ job: { id: string }; kind: string }[]>(`/api/calendar?from=${from}&to=${to}&q=${encodeURIComponent(name)}`);
  expect(events.some((e) => e.job.id === job.id && e.kind === "due")).toBe(true);
});

test("timeline renders stage bars for an in-progress job and switches the time window", async ({ page, api, apiAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const name = uniq("Timeline");
  const job = await api.createJob({ name, editorId: editor.id, dueDate: civilDate(3) });
  await (await apiAs("editor")).action(job.id, "start");

  await page.goto(`/workspace/timeline?q=${encodeURIComponent(name)}`);
  await expect(page.getByRole("heading", { name: "Timeline", level: 1 })).toBeVisible();
  const group = page.getByRole("region", { name: new RegExp(`${editor.name}: 1 job`) });
  await expect(group).toBeVisible();
  await expect(group.getByRole("link", { name: `${job.jobNumber}: Editing (In Progress)` }).first()).toBeVisible();

  const windows = page.getByRole("radiogroup", { name: "Time window" });
  for (const w of ["2 weeks", "8 weeks", "4 weeks"]) {
    await windows.getByRole("radio", { name: w }).click();
    await expect(windows.getByRole("radio", { name: w })).toBeChecked();
    await expect(group.getByRole("link", { name: new RegExp(`${job.jobNumber}: Editing`) })).toBeVisible();
  }

  // Grouping by job also works.
  await page.getByRole("radiogroup", { name: "Group rows by" }).getByRole("radio", { name: "Job" }).click();
  await expect(page.getByRole("link", { name: new RegExp(`${job.jobNumber}: Editing`) })).toBeVisible();
});
