/**
 * db/verify on fixtures only (no services): the same drift / structural checks
 * as verify.test.ts, built with insertJobFixture + raw tampering, so the
 * integrity report is covered independently of the service layer and the seed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jobRevisions } from "@/db/schema";
import {
  fakeClock,
  insertJobFixture,
  makeTestDb,
  seedMinimalOrg,
  systemContextFor,
  type SeedIds,
  type TestDb,
} from "@/db/test-db";
import { recordEvent } from "@/server/audit";
import { withTx } from "@/server/services/_shared";
import { verifyDerived } from "./verify";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

async function deactivationEvent(userId: string, openJobs: { jobId: string; role: string; action: string }[]) {
  const sys = await systemContextFor(db, ids.organisationId);
  await withTx(
    (tx) =>
      recordEvent(tx, { ...sys, userId: ids.users.owner, isSystem: false }, {
        entityType: "user",
        entityId: userId,
        eventType: "user.deactivated",
        action: "deactivated",
        previousValue: { isActive: true },
        newValue: { isActive: false },
        metadata: { openJobs },
      }),
    { db },
  );
}

describe("verifyDerived (fixtures)", () => {
  it("is clean on fixtures and detects tampered pointer columns", async () => {
    const a = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    fakeClock.advanceMinutes(5);
    const b = await insertJobFixture(db, ids, { statusKey: "review" });
    expect(await verifyDerived(db)).toMatchObject({ ok: true, jobsChecked: 2, drift: [], structural: [] });

    await db.$client.query("UPDATE jobs SET revision_count = 7, last_activity_at = '2020-01-01T00:00:00.000Z' WHERE id = $1", [a.job.id]);
    await db.$client.query("UPDATE jobs SET editor_id = $1 WHERE id = $2", [ids.users.editor2, b.job.id]);
    const report = await verifyDerived(db);
    expect(report.ok).toBe(false);
    const columns = report.drift.map((d) => `${d.jobId === a.job.id ? "a" : "b"}.${d.column}`).sort();
    expect(columns).toEqual(["a.last_activity_at", "a.revision_count", "b.editor_id"]);
    expect(report.drift.find((d) => d.column === "revision_count")).toMatchObject({ stored: 7, derived: 0 });
  });

  it("is scoped by organisation when asked", async () => {
    const other = await seedMinimalOrg(db, { slug: "other" });
    await insertJobFixture(db, ids, { statusKey: "assigned" });
    const foreign = await insertJobFixture(db, other, { statusKey: "assigned" });
    await db.$client.query("UPDATE jobs SET reopened_count = 3 WHERE id = $1", [foreign.job.id]);
    expect((await verifyDerived(db, ids.organisationId)).ok).toBe(true);
    const otherReport = await verifyDerived(db, other.organisationId);
    expect(otherReport.drift).toEqual([{ jobId: foreign.job.id, column: "reopened_count", stored: 3, derived: 0 }]);
    expect((await verifyDerived(db)).jobsChecked).toBe(2);
  });

  it("flags a revision without its event and the stale revision pointers", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "revision" });
    const [rev] = await db
      .insert(jobRevisions)
      .values({
        organisationId: ids.organisationId,
        jobId: job.id,
        revisionNumber: 1,
        requestedByUserId: ids.users.coAdmin,
        assigneeUserId: ids.users.editor1,
        reason: "Colour",
        description: "Too warm",
        requestedAt: fakeClock.now(),
      })
      .returning({ id: jobRevisions.id });
    const report = await verifyDerived(db);
    expect(report.structural).toEqual([
      { check: "revision_has_event", jobId: job.id, detail: `revision ${rev.id} has no revision.requested event` },
    ]);
    expect(report.drift.map((d) => d.column).sort()).toEqual(["open_revision_id", "revision_count"]);
  });

  it("flags an open job held by an inactive editor unless the LATEST deactivation kept it", async () => {
    const held = await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor2 });
    const done = await insertJobFixture(db, ids, { statusKey: "completed", editorId: ids.users.editor2 });
    await db.$client.query("UPDATE users SET is_active = false, deactivated_at = $1 WHERE id = $2", [fakeClock.now(), ids.users.editor2]);

    // No deactivation event: the open job is unexplained; the completed one is fine.
    expect((await verifyDerived(db)).structural.map((s) => [s.check, s.jobId])).toEqual([
      ["active_job_held_by_inactive_editor", held.job.id],
    ]);

    // The deactivation explicitly kept it → flagged exception, not an issue.
    fakeClock.advanceMinutes(1);
    await deactivationEvent(ids.users.editor2, [
      { jobId: held.job.id, role: "editor", action: "kept" },
      { jobId: done.job.id, role: "editor", action: "kept" },
    ]);
    expect((await verifyDerived(db)).structural).toEqual([]);

    // A later deactivation (same millisecond: insertion order decides) that did not keep it wins.
    await deactivationEvent(ids.users.editor2, [{ jobId: held.job.id, role: "editor", action: "unassigned" }]);
    expect((await verifyDerived(db)).structural.map((s) => s.check)).toEqual(["active_job_held_by_inactive_editor"]);
  });

  it("runs inside a caller's transaction too", async () => {
    await insertJobFixture(db, ids, { statusKey: "new" });
    const report = await withTx((tx) => verifyDerived(tx), { db });
    expect(report).toMatchObject({ ok: true, jobsChecked: 1 });
  });
});
