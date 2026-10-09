import { ROLE_EMAILS, escapeRegExp, eventually, stagesOf, uniq, type SessionView } from "./api";
import { expect, historyList, jobHeading, test } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * Assignment (spec §40 "assignment" + edge case "reassigned mid-edit";
 * ARCHITECTURE §4.5): assign through the dialog, reassign while In Progress →
 * status unchanged, stage re-attributed, old editor loses every action but
 * keeps read-only visibility, history names both editors.
 */

async function chooseInAssignDialog(page: Page, personName: string, submitLabel: "Assign" | "Reassign", reason?: string) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("searchbox", { name: "Search editors" }).fill(personName);
  await dialog.getByRole("radio", { name: new RegExp(escapeRegExp(personName)) }).click();
  if (reason) await dialog.getByLabel(/Reason/).fill(reason);
  await dialog.getByRole("button", { name: submitLabel, exact: true }).click();
  await expect(dialog).toBeHidden();
}

test("assign via dialog, reassign mid-edit: old editor loses actions, history shows both", async ({ page, api, apiAs, pageAs }) => {
  const editor1 = await api.userByEmail(ROLE_EMAILS.editor);
  const newEditor = await api.inviteUser("editor", "Reassign");
  const job = await api.createJob({ name: uniq("Assign flow") });

  // 1) Assign editor01 through the dialog.
  await page.goto(`/jobs/${job.id}`);
  await page.getByRole("button", { name: "Assign editor" }).first().click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Assign editor" })).toBeVisible();
  await chooseInAssignDialog(page, editor1.name, "Assign");

  await eventually(async () => (await api.job(job.id)).job.editor?.id === editor1.id);
  expect((await api.job(job.id)).job.statusCategory).toBe("assigned");

  // 2) editor01 accepts and starts (mid-edit).
  const e1 = await apiAs("editor");
  await e1.action(job.id, "accept");
  await e1.action(job.id, "start");
  expect((await api.job(job.id)).job.statusCategory).toBe("in_progress");

  // The editor sees the Submit action on their own job.
  const editorPage = await pageAs("editor");
  await editorPage.goto(`/jobs/${job.id}`);
  await expect(jobHeading(editorPage)).toBeVisible();
  await expect(editorPage.getByRole("button", { name: "Submit for review" })).toBeVisible();

  // 3) Owner reassigns mid-edit through the dialog.
  await page.reload();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Reassign editor…" }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Reassign editor" })).toBeVisible();
  await chooseInAssignDialog(page, newEditor.user.name, "Reassign", "E2E: editor on leave");

  const after = await eventually(async () => {
    const d = await api.job(job.id);
    return d.job.editor?.id === newEditor.user.id ? d : null;
  });
  // Status unchanged: the stage is re-attributed, not restarted.
  expect(after.job.statusCategory).toBe("in_progress");

  // 4) Old editor: still sees the job (read-only), but has no actions.
  await editorPage.reload();
  await expect(jobHeading(editorPage)).toBeVisible();
  await expect(editorPage.getByRole("button", { name: "Submit for review" })).toHaveCount(0);
  await expect(editorPage.getByText("No actions available to you at this stage.")).toBeVisible();
  const denied = await e1.raw("POST", `/api/jobs/${job.id}/submit`, { expectedVersion: after.job.version });
  expect([403, 422]).toContain(denied.status);
  expect((await api.job(job.id)).job.statusCategory).toBe("in_progress");

  // 5) History shows both editors and the re-attribution.
  const history = await api.history(job.id);
  const stages = history.filter((h) => h.kind === "stage").map((h) => h.stage!);
  const editorsAtEntry = stages.map((s) => s.editorAtEntry?.id).filter(Boolean);
  expect(editorsAtEntry).toContain(editor1.id);
  expect(editorsAtEntry).toContain(newEditor.user.id);
  expect(stages.some((s) => s.kind === "reattribution" && s.editorAtEntry?.id === newEditor.user.id)).toBe(true);

  await page.goto(`/jobs/${job.id}?tab=history`);
  await expect(historyList(page)).toContainText(editor1.name);
  await expect(historyList(page)).toContainText(newEditor.user.name);
});

test("reassigning mid-edit stops the old editor's timer, keeps them read-only and lets the new editor submit", async ({ api, loginAs }) => {
  const editorA = await api.inviteUser("editor", "Handover A");
  const editorB = await api.inviteUser("editor", "Handover B");
  const job = await api.createJob({ name: uniq("Handover"), editorId: editorA.user.id });
  const a = await loginAs(editorA.email, editorA.tempPassword);
  await a.action(job.id, "accept");
  await a.action(job.id, "start", { startTimer: true });
  expect(await a.get<SessionView | null>("/api/me/timer"), "editor A has a running timer").not.toBeNull();

  await api.assignEditor(job.id, editorB.user.id, "E2E rebalance workload");
  const after = await api.job(job.id);
  expect(after.job.statusCategory).toBe("in_progress");
  expect(after.job.editor?.id).toBe(editorB.user.id);

  // Old editor: timer closed as auto_reassigned, may still view, may not act.
  expect(await a.get<SessionView | null>("/api/me/timer")).toBeNull();
  const aSessions = (await api.sessions(job.id)).sessions.filter((s) => s.user.id === editorA.user.id);
  expect(aSessions.length).toBeGreaterThan(0);
  expect(aSessions.every((s) => !s.isRunning && s.endedAt)).toBe(true);
  expect(aSessions.some((s) => s.endReason === "auto_reassigned")).toBe(true);
  const aView = await a.job(job.id);
  expect(aView.actions.transitions).toHaveLength(0);
  expect(aView.actions.canUseTimer).toBe(false);
  expect([403, 404, 422]).toContain((await a.raw("POST", `/api/jobs/${job.id}/submit`, { expectedVersion: aView.job.version })).status);

  // The earlier in_progress stage keeps editor A; the current reattribution credits editor B.
  const stages = stagesOf(await api.history(job.id));
  const inProgress = stages.filter((st) => st.toCategory === "in_progress");
  expect(inProgress[0].editorAtEntry?.id).toBe(editorA.user.id);
  const reattribution = stages.find((st) => st.kind === "reattribution");
  expect(reattribution?.editorAtEntry?.id).toBe(editorB.user.id);
  expect(reattribution?.isCurrent).toBe(true);

  // The new editor carries on.
  const b = await loginAs(editorB.email, editorB.tempPassword);
  expect((await b.action(job.id, "submit")).job.statusCategory).toBe("submitted");
});
