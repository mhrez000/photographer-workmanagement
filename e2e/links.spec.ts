import { ROLE_EMAILS, eventually, uniq, uniqUrl } from "./api";
import { UI_TEST_TIMEOUT, expect, gotoReady, jobHeading, sectionNamed, test } from "./fixtures";

/**
 * Files (docs/SIMPLIFICATION-PLAN.md §5 section 1): three slots — Raw files (Open, Copy), Finished
 * photos (a new link replaces the old one; older ones sit under "Earlier versions"), Other links
 * (collapsed). Any link counts as the finished link, including a shared-drive folder. Supersession is
 * permanent: the old URL stays in the link history and in the audit trail (ARCHITECTURE §2.4).
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

test("Files: Raw files with Open and Copy, Finished photos with Earlier versions, Other links collapsed", async ({ page, api, apiAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const job = await api.createJob({ name: uniq("Files"), editorId: editor.id });
  const rawUrl = `https://www.dropbox.com/scl/fo/e2e-${Date.now().toString(36)}/raw`;
  await api.addLink(job.id, "raw_files", rawUrl, "Raw files");
  const floorPlan = uniqUrl("floor-plan");
  await api.addLink(job.id, "reference", floorPlan, "Floor plan");

  const ed = await apiAs("editor");
  const firstUrl = `https://www.dropbox.com/sh/e2e-${Date.now().toString(36)}/finished-v1`;
  await ed.sendForChecking(job.id, firstUrl);
  await api.askForChanges(job.id, "Tighter crop", ["Crop"]);
  const secondUrl = `https://drive.google.com/drive/folders/e2e-${Date.now().toString(36)}-finished-v2`;
  await ed.sendForChecking(job.id, secondUrl);

  // The server keeps every version: current = v2, history includes v1.
  const slot = await eventually(async () => (await api.links(job.id, true)).find((s) => s.kind === "finished_files" && s.current?.url === secondUrl) ?? null);
  expect(slot.history.map((h) => h.url)).toContain(firstUrl);
  const replaced = (await api.activity(job.id)).items.find((e) => e.eventType === "link.replaced");
  expect(replaced, "link.replaced event").toBeTruthy();
  expect((replaced!.previousValue as { url: string }).url).toBe(firstUrl);
  expect((replaced!.newValue as { url: string }).url).toBe(secondUrl);

  await gotoReady(page, `/jobs/${job.id}`, jobHeading(page));
  const files = sectionNamed(page, /^files/i);
  await expect(files).toBeVisible();
  // Three slots, in order.
  expect((await files.getByRole("heading", { level: 3 }).allInnerTexts()).map((t) => t.trim())).toEqual(["Raw files", "Finished photos", "Other links"]);
  // Raw files: Open + Copy.
  await expect(files.locator(`a[href="${rawUrl}"]`).first()).toBeVisible();
  await expect(files.getByRole("button", { name: /^copy$/i }).first()).toBeVisible();
  // Finished photos: the current link, with the older one under "Earlier versions (1)".
  await expect(files.locator(`a[href="${secondUrl}"]`).first()).toBeVisible();
  await expect(files.locator(`a[href="${firstUrl}"]`)).toBeHidden();
  const earlier = files.locator("summary").filter({ hasText: /Earlier versions \(1\)/i });
  await expect(earlier).toBeVisible();
  await earlier.click();
  await expect(files.locator(`a[href="${firstUrl}"]`)).toBeVisible();
  // Other links: collapsed by default, the floor plan inside.
  await expect(files.locator(`a[href="${floorPlan}"]`)).toBeHidden();
  await files.locator("summary").filter({ hasText: /1 link/i }).click();
  await expect(files.locator(`a[href="${floorPlan}"]`)).toBeVisible();
  // No visible link-kind picker (plan §5 "7 link kinds as visible choices" go).
  await expect(files.getByRole("combobox", { name: /kind/i })).toHaveCount(0);
  // Links open safely in a new tab.
  const anchor = files.locator(`a[href="${secondUrl}"]`).first();
  await expect(anchor).toHaveAttribute("target", "_blank");
  await expect(anchor).toHaveAttribute("rel", /noopener/);
});

test("any link counts as the finished link (a shared-drive folder too); the editor cannot change it once sent", async ({ api, apiAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const job = await api.createJob({ name: uniq("Any link"), editorId: editor.id });
  const ed = await apiAs("editor");
  const folder = `https://drive.google.com/drive/folders/e2e-folder-${Date.now().toString(36)}`;
  const sent = await ed.sendForChecking(job.id, folder);
  expect(sent.job.statusCategory).toBe("submitted");
  expect(sent.finishedWork.map((l) => l.url)).toContain(folder);
  // Once sent, the editor's links freeze (403/422); the owner may still add or replace.
  expect([403, 422]).toContain((await ed.raw("POST", `/api/jobs/${job.id}/links`, { kind: "finished_files", url: uniqUrl("late") })).status);
  const slot = (await api.links(job.id)).find((s) => s.kind === "finished_files");
  const replacement = uniqUrl("owner-replaced");
  const res = await api.raw("POST", `/api/links/${slot!.current!.id}/replace`, { url: replacement });
  expect(res.status).toBe(200);
  expect((await api.links(job.id)).find((s) => s.kind === "finished_files")?.current?.url).toBe(replacement);
});

test("the owner's raw-files link is on the editor's card and page before work starts", async ({ api, pageAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const job = await api.createJob({ name: uniq("Raw on card"), editorId: editor.id });
  const rawUrl = uniqUrl("raw");
  await api.addLink(job.id, "raw_files", rawUrl, "Raw files");
  const page = await pageAs("editor");
  await gotoReady(page, "/my-jobs", page.getByRole("main").getByText(job.name));
  const card = page.getByRole("main").getByRole("listitem").filter({ hasText: job.name }).first();
  await expect(card.getByRole("link", { name: /raw files/i })).toHaveAttribute("href", rawUrl);
  await gotoReady(page, `/jobs/${job.id}`, jobHeading(page));
  await expect(page.getByRole("main").getByRole("link", { name: /open raw files/i })).toHaveAttribute("href", rawUrl);
});
