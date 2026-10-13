import { ROLE_EMAILS, stagesOf, uniq } from "./api";
import { UI_TEST_TIMEOUT, expect, gotoReady, jobHeading, sectionNamed, stagePill, test } from "./fixtures";

/**
 * Rounds of changes (docs/SIMPLIFICATION-PLAN.md §4 "Round 2", §5 section 3 "Changes asked"): each
 * request is a numbered round that is never overwritten; the job page lists every round with what was
 * asked, by whom and when, and "Fixed and sent back" or "Open"; the pill reads Round N while checking.
 */

test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

test("round 1 and round 2 are numbered, kept and shown separately; the pill reads Round 3 on the third check", async ({ page, api, apiAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const job = await api.createJob({ name: uniq("Rounds"), editorId: editor.id });
  const ed = await apiAs("editor");
  await ed.sendForChecking(job.id);

  const first = await api.askForChanges(job.id, "Images 3–5 are too warm.", ["Colour"]);
  expect(first.revision.revisionNumber).toBe(1);
  await ed.sendForChecking(job.id, undefined, "Cooled the white balance");
  expect((await api.job(job.id)).job.revisionCount).toBe(1);

  const second = await api.askForChanges(job.id, "Image 12 was not delivered.", ["Missing photos"]);
  expect(second.revision.revisionNumber).toBe(2);
  expect(second.revision.id).not.toBe(first.revision.id);

  let detail = await api.job(job.id);
  expect(detail.job.revisionCount).toBe(2);
  const byNumber = Object.fromEntries(detail.revisions.map((r) => [r.revisionNumber, r]));
  expect(byNumber[1].reason).toBe("Colour");
  expect(byNumber[1].description).toBe("Images 3–5 are too warm.");
  expect(byNumber[1].resolvedAt).toBeTruthy();
  expect(byNumber[2].reason).toBe("Missing photos");
  expect(byNumber[2].resolvedAt).toBeNull();
  expect(detail.openRevision?.id).toBe(second.revision.id);
  expect(detail.revisions.filter((r) => r.isOpen)).toHaveLength(1);
  expect(detail.openRevision?.assignee?.id).toBe(editor.id); // back to the same editor

  // UI while round 2 is open: Changes asked, the section lists both rounds.
  await gotoReady(page, `/jobs/${job.id}`, jobHeading(page));
  await expect(stagePill(page, "changes_asked")).toBeVisible();
  const section = sectionNamed(page, /^changes asked/i);
  await expect(section).toContainText("Images 3–5 are too warm.");
  await expect(section).toContainText("Image 12 was not delivered.");
  await expect(section).toContainText(/Fixed and sent back/i);
  await expect(section.getByText("Open", { exact: true })).toHaveCount(1);
  await expect(section).toContainText(/Round 1/i);
  await expect(section).toContainText(/Round 2/i);
  await expect(section).toContainText("Mo Carter");

  await ed.sendForChecking(job.id, undefined, "Added image 12");
  await page.reload();
  await expect(stagePill(page, "ready_to_check")).toBeVisible();
  await expect(page.getByRole("main").getByText(/^Round 3$/).first()).toBeVisible();
  await api.approve(job.id, "n/a");

  detail = await api.job(job.id);
  expect(detail.revisions.map((r) => r.revisionNumber).sort()).toEqual([1, 2]);
  expect(detail.revisions.every((r) => r.resolvedAt && r.resolution === "resubmitted")).toBe(true);
  expect(detail.openRevision).toBeNull();
  expect(detail.job.statusCategory).toBe("completed");

  const history = await api.history(job.id);
  const requested = history.filter((h) => h.event?.eventType === "revision.requested").map((h) => (h.event!.newValue as { revisionNumber: number }).revisionNumber);
  expect(requested).toEqual([1, 2]);
  const cats = stagesOf(history).map((st) => st.toCategory);
  expect(cats.filter((c) => c === "revision")).toHaveLength(2);
  expect(cats.filter((c) => c === "resubmitted")).toHaveLength(2);
  expect(cats.indexOf("submitted")).toBeLessThan(cats.indexOf("revision"));
  expect(cats.at(-1)).toBe("completed");

  await page.reload();
  await expect(sectionNamed(page, /^changes asked/i).getByText("Open", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("main").getByText(/2 rounds of changes/i).first()).toBeVisible(); // the Next step card (and its phone twin)
});

test("Changes asked is hidden until a round exists; the editor's card and page quote the request", async ({ page, api, apiAs, pageAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const job = await api.createJob({ name: uniq("Rounds hidden"), editorId: editor.id });
  await gotoReady(page, `/jobs/${job.id}`, jobHeading(page));
  await expect(page.getByRole("main").getByRole("heading", { name: /^changes asked/i })).toHaveCount(0);

  const ed = await apiAs("editor");
  await ed.sendForChecking(job.id);
  const note = `Remove the agent's car from the driveway shot ${Date.now().toString(36)}`;
  await api.askForChanges(job.id, note, ["Remove items"]);

  const edPage = await pageAs("editor");
  await gotoReady(edPage, "/my-jobs", edPage.getByRole("main").getByText(job.name));
  const card = edPage.getByRole("main").getByRole("listitem").filter({ hasText: job.name }).first();
  await expect(card).toContainText(note);
  await gotoReady(edPage, `/jobs/${job.id}`, jobHeading(edPage));
  await expect(edPage.getByRole("main")).toContainText(note);
  await expect(edPage.getByRole("main").getByRole("button", { name: /^send for checking$/i })).toBeVisible();
});
