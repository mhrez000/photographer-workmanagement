import { loginApi } from "./api";
import { expect, storageFor, test } from "./fixtures";

/**
 * Dashboard (spec §40 "workloads / analytics"; ARCHITECTURE §10): the 8 KPI
 * cards render and link into All Work; a user's widget order persists.
 */

const KPI_LABELS = ["Active jobs", "Due today", "Overdue", "Awaiting editor", "In editing", "Awaiting review", "Revision required", "Completed this week"];

test("the owner dashboard renders the 8 KPI cards, each linking into All Work", async ({ page }) => {
  await page.goto("/dashboard");
  const kpis = page.getByRole("region", { name: "Key numbers" });
  await expect(kpis).toBeVisible();
  for (const label of KPI_LABELS) {
    await expect(kpis.getByRole("link", { name: new RegExp(`^${label}: \\d+ jobs?\\. View in All Work$`) })).toBeVisible();
  }

  await kpis.getByRole("link", { name: /^Overdue: / }).click();
  await expect(page).toHaveURL(/\/workspace\/all\?.*quick=overdue/);
  await expect(page.getByRole("table", { name: "All work" })).toBeVisible();
});

test("customise: moving a widget earlier persists after save and reload", async ({ api, pageWithState }) => {
  // A fresh team member starts from the persona default layout, which is never shared.
  const member = await api.inviteUser("photographer", "Dash");
  const memberApi = await loginApi(member.email, member.tempPassword);
  const before = await memberApi.get<{ layout: { widgets: { id: string; type: string }[] }; version: number }>("/api/dashboard/layout");
  expect(before.layout.widgets.length).toBeGreaterThan(2);

  const page = await pageWithState(await storageFor(member.email, member.tempPassword));
  await page.goto("/dashboard?customise=1");
  const list = page.getByRole("list", { name: "Dashboard widgets" });
  await expect(list).toBeVisible();
  const tiles = list.locator(":scope > li");
  const firstLabel = (await tiles.nth(0).locator("span.truncate").first().innerText()).trim();
  const secondLabel = (await tiles.nth(1).locator("span.truncate").first().innerText()).trim();

  await list.getByRole("button", { name: `Move ${secondLabel} earlier` }).click();
  await expect(tiles.nth(0)).toContainText(secondLabel);
  await page.getByRole("button", { name: "Save layout" }).click();

  // Persisted server-side…
  await expect
    .poll(async () => {
      const now = await memberApi.get<{ layout: { widgets: { id: string }[] }; version: number }>("/api/dashboard/layout");
      return now.layout.widgets.slice(0, 2).map((w) => w.id).join(",");
    })
    .toBe([before.layout.widgets[1].id, before.layout.widgets[0].id].join(","));

  // …and after a reload.
  await page.goto("/dashboard?customise=1");
  await expect(list.locator(":scope > li").nth(0)).toContainText(secondLabel);
  await expect(list.locator(":scope > li").nth(1)).toContainText(firstLabel);

  // Reset restores the persona default.
  await memberApi.post("/api/dashboard/layout/reset");
  const reset = await memberApi.get<{ layout: { widgets: { id: string }[] } }>("/api/dashboard/layout");
  expect(reset.layout.widgets[0].id).toBe(before.layout.widgets[0].id);
  await memberApi.ctx.dispose();
});

test("editors get the personal dashboard variant", async ({ pageAs }) => {
  const page = await pageAs("editor");
  await page.goto("/dashboard");
  await expect(page.getByRole("main")).toContainText(/My workload|my work/i);
});
