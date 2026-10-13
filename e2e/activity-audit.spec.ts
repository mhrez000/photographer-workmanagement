import { ROLE_EMAILS, uniq } from "./api";
import { UI_TEST_TIMEOUT, expect, gotoReady, jobHeading, test, whoDidWhat } from "./fixtures";

/**
 * "Every change, by everyone, forever" (docs/SIMPLIFICATION-PLAN.md §5 "Who did what", §9 "History";
 * ARCHITECTURE §5): the job page's short dated list links to the Full history; the studio-wide audit
 * log lives under Settings → History and shows before → after; the log is append-only and the
 * integrity check reports no drift.
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

test("Who did what on the job page, and Full history with every underlying step", async ({ page, api, apiAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const job = await api.createJob({ name: uniq("Audit who did what"), editorId: editor.id });
  const ed = await apiAs("editor");
  await ed.sendForChecking(job.id);
  await api.askForChanges(job.id, "Tighter crop on the hero", ["Crop"]);
  await ed.sendForChecking(job.id);
  await api.approve(job.id, "n/a");

  await gotoReady(page, `/jobs/${job.id}`, jobHeading(page));
  const list = whoDidWhat(page);
  for (const step of [/Created by Mo Carter/, /Given to Sam Whitfield/, /Started editing/, /Sent for checking by Sam Whitfield/, /Changes asked \(round 1\)/, /Sent back for checking/, /Approved by Mo Carter/]) {
    await expect(list, `${step}`).toContainText(step);
  }
  // The short list never shows raw status names or event verbs.
  await expect(list).not.toContainText(/Ready for Assignment|Accepted|Resubmitted|status_changed/);

  const full = list.getByRole("link", { name: /full history/i });
  await expect(full).toHaveAttribute("href", `/jobs/${job.id}/history`);
  await full.click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${job.id}/history`));
  await expect(page.getByRole("main").getByRole("heading", { name: /full history/i })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("main")).toContainText(/approved/i, { timeout: 60_000 });
  // The complete, permanent log: every underlying status is its own row.
  const text = await page.getByRole("main").innerText();
  for (const word of [/created/i, /assigned|given/i, /started/i, /submitted|sent (the work )?for checking/i, /revision|changes/i, /approved/i, /completed|closed/i]) expect(text, `${word}`).toMatch(word);

  // The API agrees.
  const history = await api.history(job.id);
  const cats = history.filter((h) => h.kind === "stage").map((h) => h.stage!.toCategory);
  for (const c of ["assigned", "in_progress", "submitted", "revision", "resubmitted", "approved", "completed"]) expect(cats, c).toContain(c);
  const actors = history.filter((h) => h.kind === "event").map((h) => h.event!);
  expect(actors.find((e) => e.eventType === "job.submitted")?.actor?.id).toBe(editor.id);
  expect(actors.find((e) => e.eventType === "revision.requested")?.actor?.id).toBe((await api.me()).user.id);
});

test("Settings → History filtered by job number shows the change with before → after", async ({ page, api }) => {
  const job = await api.createJob({ name: uniq("Audit"), priority: "normal" });
  await api.patch(`/api/jobs/${job.id}`, { expectedVersion: await api.version(job.id), priority: "urgent" });

  // Server: the event carries before/after values.
  const activity = await api.activity(job.id);
  const priority = activity.items.find((e) => e.eventType === "job.priority_changed");
  expect(priority?.previousValue).toEqual({ priority: "normal" });
  expect(priority?.newValue).toEqual({ priority: "urgent" });

  await gotoReady(page, "/settings/history", page.getByRole("textbox", { name: "Job number" }));
  const jobBox = page.getByRole("textbox", { name: "Job number" });
  await jobBox.fill(job.jobNumber);
  await jobBox.press("Enter");
  await expect(page).toHaveURL(new RegExp(`job=${job.jobNumber}`));

  const feed = page.getByRole("main");
  await expect(feed).toContainText(/showing the history of/i);
  const line = feed.getByRole("listitem").filter({ hasText: /rush|urgent|priority/i }).first();
  await expect(line).toBeVisible();
  await expect(feed.getByRole("listitem").filter({ hasText: /created/i }).filter({ hasText: job.jobNumber })).toHaveCount(1);
  await expect(feed.getByRole("listitem").filter({ hasText: /PJ-\d+/ }).filter({ hasNotText: job.jobNumber })).toHaveCount(0);

  const toggle = line.getByRole("button", { name: /before → after/i });
  await toggle.click();
  await expect(line.getByRole("button", { name: /hide details/i })).toHaveAttribute("aria-expanded", "true");
  const details = line.locator("dl");
  await expect(details).toContainText(/normal/i);
  await expect(details).toContainText(/urgent|rush/i);
  await expect(details.getByLabel("changed to")).toBeVisible();
});

test("audit log is append-only and the integrity check reports zero drift", async ({ api, apiAs }) => {
  const job = await api.createJob({ name: uniq("Immutable") });
  for (const [method, url] of [
    ["DELETE", `/api/activity`],
    ["PATCH", `/api/activity`],
    ["DELETE", `/api/jobs/${job.id}/history`],
    ["PATCH", `/api/jobs/${job.id}/history`],
  ] as const) {
    const r = await api.raw(method, url, {});
    expect([404, 405], `${method} ${url}`).toContain(r.status);
  }

  const report = await api.get<{ ok: boolean; drift: unknown[]; structural: unknown[] }>("/api/system/integrity");
  expect(report.drift, JSON.stringify(report.drift).slice(0, 500)).toEqual([]);
  expect(report.structural, JSON.stringify(report.structural).slice(0, 500)).toEqual([]);
  expect(report.ok).toBe(true);

  // Owners only: the extra photographer and an editor are refused.
  for (const role of ["photographer", "editor"] as const) {
    const other = await apiAs(role);
    expect((await other.raw("GET", "/api/system/integrity")).status, role).toBe(403);
  }
});
