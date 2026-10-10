import { uniq } from "./api";
import { expect, test } from "./fixtures";

/**
 * Activity history + audit trail (spec §37, §40 "activity history", "audit
 * trail"; ARCHITECTURE §5): the global Activity Log filtered by job shows each
 * change with before → after; the audit log is append-only and the integrity
 * check reports no drift.
 */

test("Activity Log filtered by job number shows the change with before → after", async ({ page, api }) => {
  const job = await api.createJob({ name: uniq("Audit"), priority: "normal" });
  await api.patch(`/api/jobs/${job.id}`, { expectedVersion: await api.version(job.id), priority: "urgent" });

  // Server: the event carries before/after values.
  const activity = await api.activity(job.id);
  const priority = activity.items.find((e) => e.eventType === "job.priority_changed");
  expect(priority?.previousValue).toEqual({ priority: "normal" });
  expect(priority?.newValue).toEqual({ priority: "urgent" });

  // UI: type the job number into the filter.
  await page.goto("/activity");
  const jobBox = page.getByRole("textbox", { name: "Job number" });
  await jobBox.fill(job.jobNumber);
  await jobBox.press("Enter");
  await expect(page).toHaveURL(new RegExp(`job=${job.jobNumber}`));

  const feed = page.getByRole("main");
  const line = feed.getByRole("listitem").filter({ hasText: /changed priority from Normal to Urgent/i });
  await expect(line).toHaveCount(1);
  await expect(feed.getByRole("listitem").filter({ hasText: `created ${job.jobNumber}` })).toHaveCount(1);
  // Only this job's events are listed.
  await expect(feed.getByRole("listitem").filter({ hasText: /PJ-\d+/ }).filter({ hasNotText: job.jobNumber })).toHaveCount(0);

  const toggle = line.getByRole("button", { name: "Before → after" });
  await toggle.click();
  await expect(line.getByRole("button", { name: "Hide details" })).toHaveAttribute("aria-expanded", "true");
  const details = line.locator("dl");
  await expect(details).toContainText("Normal");
  await expect(details).toContainText("Urgent");
  await expect(details.getByLabel("changed to")).toBeVisible();
});

test("audit log is append-only and the integrity check reports zero drift", async ({ api, apiAs }) => {
  // No write routes exist for activity / history.
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

  // Admins only (docs/ROLES.md §3.3 system.integrity): even a team member with every switch on
  // (photographer01, the v2 equivalent of a v1 manager) and an editor are refused.
  for (const role of ["photographer", "editor"] as const) {
    const other = await apiAs(role);
    expect((await other.raw("GET", "/api/system/integrity")).status, role).toBe(403);
  }
});
