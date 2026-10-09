import { ROLE_EMAILS, eventually, uniq } from "./api";
import { expect, historyList, openJob, test } from "./fixtures";

/**
 * Finished-work links (spec §35, §40 "links" + edge case "link changed";
 * ARCHITECTURE §2.4 link supersession): add a link, replace it, the old URL is
 * kept in the link history and in the audit trail, and the Finished Work panel
 * shows who added the current link.
 */

interface LinkSlotView {
  kind: string;
  current: { id: string; url: string; addedBy: { id: string; name: string } } | null;
  history: { id: string; url: string; supersededAt?: string | null }[];
}

test("add a finished-work link, replace it: history keeps the old URL; panel shows Added by", async ({ page, api, apiAs, pageAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const owner = await api.me();
  const job = await api.createJob({ name: uniq("Links"), editorId: editor.id });
  const ed = await apiAs("editor");
  await ed.action(job.id, "start");

  const stamp = Date.now().toString(36);
  const firstUrl = `https://www.dropbox.com/sh/e2e-${stamp}/finished-v1`;
  const secondUrl = `https://drive.google.com/drive/folders/e2e-${stamp}-finished-v2`;

  /* ---- editor adds the Finished files link through the Links tab ---- */
  const edPage = await pageAs("editor");
  await openJob(edPage, job.id, "links");
  await edPage.getByRole("button", { name: "Add link", exact: true }).first().click();
  let dialog = edPage.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Add a link" })).toBeVisible();
  await dialog.getByRole("combobox", { name: /Kind/ }).selectOption({ label: "Finished files" });
  await dialog.getByRole("textbox", { name: "Link", exact: true }).fill(firstUrl);
  await dialog.getByRole("button", { name: "Add link" }).click();
  await expect(dialog).toBeHidden();

  const added = await eventually(async () => {
    const slots = await api.get<LinkSlotView[]>(`/api/jobs/${job.id}/links`);
    return slots.find((s) => s.kind === "finished_files" && s.current?.url === firstUrl)?.current ?? null;
  });
  expect(added.addedBy.id).toBe(editor.id);

  /* ---- owner replaces it ---- */
  await openJob(page, job.id, "links");
  await page.getByRole("button", { name: "Replace", exact: true }).first().click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Replace finished files link" })).toBeVisible();
  await dialog.getByRole("textbox", { name: "Link", exact: true }).fill(secondUrl);
  await dialog.getByRole("button", { name: "Replace link" }).click();
  await expect(dialog).toBeHidden();

  const slot = await eventually(async () => {
    const slots = await api.get<LinkSlotView[]>(`/api/jobs/${job.id}/links?history=1`);
    return slots.find((s) => s.kind === "finished_files" && s.current?.url === secondUrl) ?? null;
  });
  // The old link is superseded, never deleted or edited in place.
  expect(slot.current?.addedBy.id).toBe(owner.user.id);
  expect(slot.history.map((h) => h.url)).toContain(firstUrl);

  // The audit trail records old → new.
  const activity = await api.activity(job.id);
  const replaced = activity.items.find((e) => e.eventType === "link.replaced");
  expect(replaced, "link.replaced event").toBeTruthy();
  expect((replaced!.previousValue as { url: string }).url).toBe(firstUrl);
  expect((replaced!.newValue as { url: string }).url).toBe(secondUrl);

  /* ---- UI: old version listed under "1 earlier version" ---- */
  await page.reload();
  const earlier = page.getByText("1 earlier version");
  await expect(earlier).toBeVisible();
  await earlier.click();
  await expect(page.locator(`a[href="${firstUrl}"]`)).toBeVisible();
  await expect(page.locator(`a[href="${secondUrl}"]`).first()).toBeVisible();

  /* ---- Finished Work panel on Overview: Added by + link ---- */
  await openJob(page, job.id);
  const panel = page.locator("section[aria-labelledby='finished-work-title']");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Added by");
  await expect(panel).toContainText(owner.user.name);
  await expect(panel.locator(`a[href="${secondUrl}"]`)).toBeVisible();

  /* ---- The job History still shows the activity (permanent record) ---- */
  await openJob(page, job.id, "activity");
  await expect(page.getByRole("tabpanel")).toContainText(/replaced/i);
  void historyList;
});
