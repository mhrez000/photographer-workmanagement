/**
 * db/verify (ARCHITECTURE.md §2.8, §13): a small organisation driven through
 * the real services has zero drift; tampering with a pointer column or an
 * invariant is detected; the full demo seed passes verify as well.
 *
 * Depends on the converted (async) services and the seed — see
 * verify.fixture.test.ts for the fixture-only coverage of the same checks.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tx } from "@/db/index";
import { jobs, users } from "@/db/schema";
import { contextFor, fakeClock, makeTestDb, seedMinimalOrg, type FixtureUserKey, type SeedIds, type TestDb } from "@/db/test-db";
import type { AuthContext, Job } from "@/lib/types";
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

/** Runs a service as `actor` in its own transaction (input is evaluated BEFORE the transaction opens). */
async function act<I, R>(actor: FixtureUserKey, fn: (tx: Tx, ctx: AuthContext, input: I) => Promise<R>, input: I): Promise<R> {
  const ctx = await contextFor(db, ids.users[actor]);
  return withTx((tx) => fn(tx, ctx, input), { db });
}
const jobRow = async (id: string): Promise<Job> => (await db.select().from(jobs).where(eq(jobs.id, id)))[0] as Job;
const v = async (id: string) => (await jobRow(id)).version;
const later = (minutes = 30) => fakeClock.advanceMinutes(minutes);

async function newJob(name: string): Promise<string> {
  later(5);
  const { job } = await act("photographer1", createJob, { name, projectId: ids.projectId, jobTypeId: ids.defaultJobTypeId, dueDate: "2026-10-12" });
  later(5);
  await act("photographer1", addLink, { jobId: job.id, kind: "raw_files", url: "https://www.dropbox.com/scl/fo/raw" });
  return job.id;
}

async function assign(jobId: string, editor: FixtureUserKey, actor: FixtureUserKey = "photographer1") {
  later();
  await act(actor, assignEditor, { jobId, userId: ids.users[editor], expectedVersion: await v(jobId) });
}

async function editToSubmit(jobId: string, editor: FixtureUserKey) {
  later();
  await act(editor, startJob, { jobId, expectedVersion: await v(jobId) });
  later(120);
  await act(editor, addLink, { jobId, kind: "finished_files", url: "https://drive.google.com/drive/folders/done" });
  await act(editor, submitJob, { jobId, expectedVersion: await v(jobId) });
}

/** A small organisation with the interesting histories, all through services. */
async function seedSmallOrg(): Promise<Record<string, string>> {
  // 1. Full lifecycle with a revision, completion, reopen and re-completion.
  const full = await newJob("14 Ocean Street · Listing photos");
  await assign(full, "editor1");
  later();
  await act("editor1", acceptJob, { jobId: full, expectedVersion: await v(full) });
  await editToSubmit(full, "editor1");
  later(60);
  await act("photographer1", requestRevision, {
    jobId: full,
    expectedVersion: await v(full),
    reason: "Colour",
    description: "Interiors too warm",
  });
  later(90);
  const revisionId = (await jobRow(full)).openRevisionId as string;
  await act("editor1", resolveRevision, { revisionId, expectedVersion: await v(full), note: "Fixed" });
  later(60);
  await act("photographer1", approveJob, { jobId: full, expectedVersion: await v(full) });
  later(60);
  await act("coAdmin", completeJob, { jobId: full, expectedVersion: await v(full) });
  later(600);
  await act("photographer1", reopenJob, { jobId: full, expectedVersion: await v(full), reason: "Missing room", toCategory: "in_progress" });
  later(120);
  await act("editor1", submitJob, { jobId: full, expectedVersion: await v(full) });
  later(30);
  await act("photographer1", approveJob, { jobId: full, expectedVersion: await v(full) });
  await act("photographer1", completeJob, { jobId: full, expectedVersion: await v(full) });

  // 2. Reassigned mid-edit (re-attributed stage) with a running timer that gets closed.
  const moved = await newJob("5 Carr Street · Twilight exteriors");
  await assign(moved, "editor1");
  later();
  await act("editor1", startJob, { jobId: moved, expectedVersion: await v(moved) });
  later(10);
  await act("editor1", startTimer, { jobId: moved });
  later(45);
  await act("photographer1", addComment, { jobId: moved, body: "Can you lift the sky?", mentionUserIds: [ids.users.editor1] });
  await assign(moved, "editor2", "coAdmin");

  // 3. Cancelled and restored.
  const restored = await newJob("9 Shellcove Road · Drone stills");
  await assign(restored, "editor1");
  later();
  await act("coAdmin", cancelJob, { jobId: restored, expectedVersion: await v(restored), reason: "Vendor paused" });
  later(600);
  await act("coAdmin", restoreJob, { jobId: restored, expectedVersion: await v(restored), reason: "Back on" });

  // 4. Held by an editor who is deactivated without a hand-over (flagged "kept").
  const kept = await newJob("27 Glenmore Road · Floor plan");
  await assign(kept, "editor2");
  later();
  await act("editor2", startJob, { jobId: kept, expectedVersion: await v(kept) });
  later(60);
  const [editor2] = await db.select().from(users).where(eq(users.id, ids.users.editor2));
  await act("owner", deactivateUser, { userId: ids.users.editor2, expectedVersion: editor2?.version, reason: "Leave" });

  return { full, moved, restored, kept };
}

describe("verifyDerived on a small service-driven organisation", () => {
  beforeEach(async () => {
    fakeClock.set("2026-10-06T22:00:00.000Z");
    db = await makeTestDb();
    ids = await seedMinimalOrg(db, { settings: { timeTrackingEnabled: true } });
  });
  afterEach(() => fakeClock.reset());

  it("reports zero drift and zero structural issues", async () => {
    const j = await seedSmallOrg();
    const report = await verifyDerived(db);
    expect(report.drift).toEqual([]);
    expect(report.structural).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.jobsChecked).toBe(4);
    // Sanity: the scenario produced the histories it claims to.
    expect(await jobRow(j.full)).toMatchObject({ statusCategory: "completed", reopenedCount: 1, revisionCount: 1 });
    expect(await jobRow(j.moved)).toMatchObject({ statusCategory: "in_progress", editorId: ids.users.editor2, previousEditorId: ids.users.editor1 });
    expect((await jobRow(j.restored)).statusCategory).toBe("assigned");
    expect((await jobRow(j.kept)).editorId).toBe(ids.users.editor2);
    // Scoped to one organisation as well.
    expect((await verifyDerived(db, ids.organisationId)).ok).toBe(true);
  });

  it("detects a tampered pointer column", async () => {
    const j = await seedSmallOrg();
    await db.$client.query("UPDATE jobs SET revision_count = 7, last_activity_at = '2020-01-01T00:00:00.000Z' WHERE id = $1", [j.full]);
    await db.$client.query("UPDATE jobs SET editor_id = $1 WHERE id = $2", [ids.users.editor1, j.moved]);
    const report = await verifyDerived(db);
    expect(report.ok).toBe(false);
    const columns = report.drift.map((d) => `${d.jobId === j.full ? "full" : d.jobId === j.moved ? "moved" : d.jobId}.${d.column}`).sort();
    expect(columns).toEqual(["full.last_activity_at", "full.revision_count", "moved.editor_id"]);
    expect(report.drift.find((d) => d.column === "revision_count")).toMatchObject({ stored: 7, derived: 1 });
  });

  it("flags an open job held by an inactive editor unless the deactivation kept it", async () => {
    const j = await seedSmallOrg();
    expect((await verifyDerived(db)).structural).toEqual([]);
    // editor1 deactivated behind the services' back: their open job is now unexplained.
    await db.$client.query("UPDATE users SET is_active = false, deactivated_at = $1 WHERE id = $2", [fakeClock.now(), ids.users.editor1]);
    const report = await verifyDerived(db);
    expect(report.structural.map((s) => [s.check, s.jobId])).toEqual([["active_job_held_by_inactive_editor", j.restored]]);
  });
});

describe("demo seed", () => {
  afterEach(() => fakeClock.reset());

  it("drives the full §12 plan through the services with zero drift", async () => {
    const seedDb = await makeTestDb();
    const now = new Date("2026-10-09T01:30:00.000Z"); // Friday 12:30 in Sydney
    const result = await runSeed(seedDb, { now, bcryptCost: 4 });
    expect(result.skipped).toEqual([]);
    const integrity = await verifyDerived(seedDb);
    expect(integrity.drift).toEqual([]);
    expect(integrity.structural).toEqual([]);
    const report = await buildReport(seedDb, result.northlightId, now.getTime());
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  }, 600_000);
});
