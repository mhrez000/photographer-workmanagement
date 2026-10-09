import { ROLE_EMAILS, stagesOf, uniq } from "./api";
import { expect, openJob, test } from "./fixtures";

/**
 * Multiple revisions (spec §40 "revisions" + edge case "multiple revisions";
 * ARCHITECTURE §4.4): each request is numbered #1, #2… and earlier revisions
 * are never overwritten. Each request is resolved as `resubmitted`; the stage
 * history keeps every cycle.
 */
test("revision #1 and #2 are numbered, kept and shown separately", async ({ page, api, apiAs }) => {
  const editor = await api.userByEmail(ROLE_EMAILS.editor);
  const photographer = await api.userByEmail(ROLE_EMAILS.photographer);
  const job = await api.createJob({ name: uniq("Revisions"), editorId: editor.id, photographerId: photographer.id });

  const ed = await apiAs("editor");
  const ph = await apiAs("photographer");
  await ed.action(job.id, "start");
  await ed.action(job.id, "submit");

  const first = await ph.requestRevision(job.id, "Colour cast", "Images 3–5 are too warm.");
  expect(first.revision.revisionNumber).toBe(1);
  await ed.resolveRevision(job.id, "Cooled the white balance");

  const second = await ph.requestRevision(job.id, "Missing images", "Image 12 was not delivered.");
  expect(second.revision.revisionNumber).toBe(2);
  expect(second.revision.id).not.toBe(first.revision.id);

  // #1 is intact (reason, description, resolution) while #2 is open.
  let detail = await api.job(job.id);
  expect(detail.job.revisionCount).toBe(2);
  const byNumber = Object.fromEntries(detail.revisions.map((r) => [r.revisionNumber, r]));
  expect(byNumber[1].reason).toBe("Colour cast");
  expect(byNumber[1].description).toBe("Images 3–5 are too warm.");
  expect(byNumber[1].resolvedAt).toBeTruthy();
  expect(byNumber[2].reason).toBe("Missing images");
  expect(byNumber[2].resolvedAt).toBeNull();
  expect(detail.openRevision?.id).toBe(second.revision.id);
  // Only one revision is open at a time, and the repeat revision goes back to the same editor.
  expect(detail.revisions.filter((r) => r.isOpen)).toHaveLength(1);
  expect(detail.openRevision?.assignee?.id).toBe(editor.id);

  await ed.resolveRevision(job.id, "Added image 12");
  await ph.action(job.id, "approve");

  detail = await api.job(job.id);
  expect(detail.revisions.map((r) => r.revisionNumber).sort()).toEqual([1, 2]);
  expect(detail.revisions.every((r) => r.resolvedAt && r.resolution === "resubmitted")).toBe(true);
  expect(detail.openRevision).toBeNull();
  expect(detail.job.statusCategory).toBe("approved");

  // Revisions endpoint and history agree.
  const list = await api.get<{ revisions: { revisionNumber: number; reason: string }[] }>(`/api/jobs/${job.id}/revisions`);
  expect(list.revisions.map((r) => `${r.revisionNumber}:${r.reason}`).sort()).toEqual(["1:Colour cast", "2:Missing images"]);
  const history = await api.history(job.id);
  const requested = history.filter((h) => h.event?.eventType === "revision.requested").map((h) => (h.event!.newValue as { revisionNumber: number }).revisionNumber);
  expect(requested).toEqual([1, 2]);
  // Stage history: two revision + two resubmitted stages, in sequence order, ending approved.
  const stages = stagesOf(history);
  const cats = stages.map((st) => st.toCategory);
  expect(cats.filter((c) => c === "revision")).toHaveLength(2);
  expect(cats.filter((c) => c === "resubmitted")).toHaveLength(2);
  expect(cats.indexOf("submitted")).toBeLessThan(cats.indexOf("revision"));
  expect(cats.at(-1)).toBe("approved");
  const seqs = stages.map((st) => st.sequence);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

  // UI: both revisions listed with their own reason.
  await openJob(page, job.id, "revisions");
  const revisions = page.getByRole("list", { name: "Revisions, newest first" });
  await expect(revisions.getByRole("heading", { name: /Revision #1 — Colour cast/ })).toBeVisible();
  await expect(revisions.getByRole("heading", { name: /Revision #2 — Missing images/ })).toBeVisible();
  await expect(revisions.getByRole("listitem").filter({ has: page.getByRole("heading", { name: /Revision #/ }) })).toHaveCount(2);
});
