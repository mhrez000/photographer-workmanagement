/**
 * db/verify (ARCHITECTURE.md §2.8, §13): a small organisation driven through
 * the real services has zero drift; tampering with a pointer column or an
 * invariant is detected; the full demo seed passes verify as well.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tx } from "@/db/index";
import { jobs, users } from "@/db/schema";
import { contextFor, fakeClock, makeTestDb, seedMinimalOrg, type FixtureUserKey, type SeedIds, type TestDb } from "@/db/test-db";
import type { Job } from "@/lib/types";
import { withTx } from "@/server/services/_shared";
import { createJob } from "@/server/services/jobs";
import { assignEditor } from "@/server/services/assignments";
import { requestRevision, resolveRevision } from "@/server/services/revisions";
import { addLink } from "@/server/services/links";
import { addComment } from "@/server/services/comments";
import { startTimer } from "@/server/services/timeTracking";
import { deactivateUser } from "@/server/services/users";
import {
  acceptJob,
  approveJob,
  cancelJob,
  completeJob,
  reopenJob,
  restoreJob,
  startJob,
  submitJob,
} from "@/server/services/workflow";
import { verifyDerived } from "./verify";
import { runSeed } from "./seed/index";
import { buildReport } from "./seed/summary";

let db: TestDb;
let ids: SeedIds;

const ctxOf = (key: FixtureUserKey) => contextFor(db, ids.users[key]);
const run = <T>(fn: (tx: Tx) => T): T => withTx(fn, { db });
const jobRow = (id: string): Job => db.select().from(jobs).where(eq(jobs.id, id)).get() as Job;
const v = (id: string) => jobRow(id).version;
const later = (minutes = 30) => fakeClock.advanceMinutes(minutes);

function newJob(name: string): string {
  later(5);
  const { job } = run((tx) =>
    createJob(tx, ctxOf("photographer1"), { name, projectId: ids.projectId, jobTypeId: ids.defaultJobTypeId, dueDate: "2026-10-12" }),
  );
  later(5);
  run((tx) => addLink(tx, ctxOf("photographer1"), { jobId: job.id, kind: "raw_files", url: "https://www.dropbox.com/scl/fo/raw" }));
  return job.id;
}

function assign(jobId: string, editor: FixtureUserKey, actor: FixtureUserKey = "photographer1") {
  later();
  run((tx) => assignEditor(tx, ctxOf(actor), { jobId, userId: ids.users[editor], expectedVersion: v(jobId) }));
}

function editToSubmit(jobId: string, editor: FixtureUserKey) {
  later();
  run((tx) => startJob(tx, ctxOf(editor), { jobId, expectedVersion: v(jobId) }));
  later(120);
  run((tx) => addLink(tx, ctxOf(editor), { jobId, kind: "finished_files", url: "https://drive.google.com/drive/folders/done" }));
  run((tx) => submitJob(tx, ctxOf(editor), { jobId, expectedVersion: v(jobId) }));
}

/** A small organisation with the interesting histories, all through services. */
function seedSmallOrg(): Record<string, string> {
  // 1. Full lifecycle with a revision, completion, reopen and re-completion.
  const full = newJob("14 Ocean Street · Listing photos");
  assign(full, "editor1");
  later();
  run((tx) => acceptJob(tx, ctxOf("editor1"), { jobId: full, expectedVersion: v(full) }));
  editToSubmit(full, "editor1");
  later(60);
  run((tx) =>
    requestRevision(tx, ctxOf("photographer1"), {
      jobId: full,
      expectedVersion: v(full),
      reason: "Colour",
      description: "Interiors too warm",
    }),
  );
  later(90);
  const revisionId = jobRow(full).openRevisionId as string;
  run((tx) => resolveRevision(tx, ctxOf("editor1"), { revisionId, expectedVersion: v(full), note: "Fixed" }));
  later(60);
  run((tx) => approveJob(tx, ctxOf("photographer1"), { jobId: full, expectedVersion: v(full) }));
  later(60);
  run((tx) => completeJob(tx, ctxOf("manager"), { jobId: full, expectedVersion: v(full) }));
  later(600);
  run((tx) => reopenJob(tx, ctxOf("photographer1"), { jobId: full, expectedVersion: v(full), reason: "Missing room", toCategory: "in_progress" }));
  later(120);
  run((tx) => submitJob(tx, ctxOf("editor1"), { jobId: full, expectedVersion: v(full) }));
  later(30);
  run((tx) => approveJob(tx, ctxOf("photographer1"), { jobId: full, expectedVersion: v(full) }));
  run((tx) => completeJob(tx, ctxOf("photographer1"), { jobId: full, expectedVersion: v(full) }));

  // 2. Reassigned mid-edit (re-attributed stage) with a running timer that gets closed.
  const moved = newJob("5 Carr Street · Twilight exteriors");
  assign(moved, "editor1");
  later();
  run((tx) => startJob(tx, ctxOf("editor1"), { jobId: moved, expectedVersion: v(moved) }));
  later(10);
  run((tx) => startTimer(tx, ctxOf("editor1"), { jobId: moved }));
  later(45);
  run((tx) => addComment(tx, ctxOf("photographer1"), { jobId: moved, body: "Can you lift the sky?", mentionUserIds: [ids.users.editor1] }));
  assign(moved, "editor2", "manager");

  // 3. Cancelled and restored.
  const restored = newJob("9 Shellcove Road · Drone stills");
  assign(restored, "editor1");
  later();
  run((tx) => cancelJob(tx, ctxOf("manager"), { jobId: restored, expectedVersion: v(restored), reason: "Vendor paused" }));
  later(600);
  run((tx) => restoreJob(tx, ctxOf("manager"), { jobId: restored, expectedVersion: v(restored), reason: "Back on" }));

  // 4. Held by an editor who is deactivated without a hand-over (flagged "kept").
  const kept = newJob("27 Glenmore Road · Floor plan");
  assign(kept, "editor2");
  later();
  run((tx) => startJob(tx, ctxOf("editor2"), { jobId: kept, expectedVersion: v(kept) }));
  later(60);
  const editor2 = db.select().from(users).where(eq(users.id, ids.users.editor2)).get();
  run((tx) => deactivateUser(tx, ctxOf("owner"), { userId: ids.users.editor2, expectedVersion: editor2?.version, reason: "Leave" }));

  return { full, moved, restored, kept };
}

describe("verifyDerived on a small service-driven organisation", () => {
  beforeEach(() => {
    fakeClock.set("2026-10-06T22:00:00.000Z");
    db = makeTestDb();
    ids = seedMinimalOrg(db, { settings: { timeTrackingEnabled: true } });
  });
  afterEach(() => fakeClock.reset());

  it("reports zero drift and zero structural issues", () => {
    const j = seedSmallOrg();
    const report = verifyDerived(db.$client);
    expect(report.drift).toEqual([]);
    expect(report.structural).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.jobsChecked).toBe(4);
    // Sanity: the scenario produced the histories it claims to.
    expect(jobRow(j.full)).toMatchObject({ statusCategory: "completed", reopenedCount: 1, revisionCount: 1 });
    expect(jobRow(j.moved)).toMatchObject({ statusCategory: "in_progress", editorId: ids.users.editor2, previousEditorId: ids.users.editor1 });
    expect(jobRow(j.restored).statusCategory).toBe("assigned");
    expect(jobRow(j.kept).editorId).toBe(ids.users.editor2);
    // Scoped to one organisation as well.
    expect(verifyDerived(db.$client, ids.organisationId).ok).toBe(true);
  });

  it("detects a tampered pointer column", () => {
    const j = seedSmallOrg();
    db.$client.prepare("UPDATE jobs SET revision_count = 7, last_activity_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(j.full);
    db.$client.prepare("UPDATE jobs SET editor_id = ? WHERE id = ?").run(ids.users.editor1, j.moved);
    const report = verifyDerived(db.$client);
    expect(report.ok).toBe(false);
    const columns = report.drift.map((d) => `${d.jobId === j.full ? "full" : d.jobId === j.moved ? "moved" : d.jobId}.${d.column}`).sort();
    expect(columns).toEqual(["full.last_activity_at", "full.revision_count", "moved.editor_id"]);
    expect(report.drift.find((d) => d.column === "revision_count")).toMatchObject({ stored: 7, derived: 1 });
  });

  it("flags an open job held by an inactive editor unless the deactivation kept it", () => {
    const j = seedSmallOrg();
    expect(verifyDerived(db.$client).structural).toEqual([]);
    // editor1 deactivated behind the services' back: their open job is now unexplained.
    db.$client.prepare("UPDATE users SET is_active = 0, deactivated_at = ? WHERE id = ?").run(fakeClock.now(), ids.users.editor1);
    const report = verifyDerived(db.$client);
    expect(report.structural.map((s) => [s.check, s.jobId])).toEqual([["active_job_held_by_inactive_editor", j.restored]]);
  });
});

describe("demo seed", () => {
  afterEach(() => fakeClock.reset());

  it("drives the full §12 plan through the services with zero drift", async () => {
    const seedDb = makeTestDb();
    const now = new Date("2026-10-09T01:30:00.000Z"); // Friday 12:30 in Sydney
    const result = await runSeed(seedDb, seedDb.$client, { now, bcryptCost: 4 });
    expect(result.skipped).toEqual([]);
    const integrity = verifyDerived(seedDb.$client);
    expect(integrity.drift).toEqual([]);
    expect(integrity.structural).toEqual([]);
    const report = buildReport(seedDb, seedDb.$client, result.northlightId, now.getTime());
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  }, 180_000);
});
