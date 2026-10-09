import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { moveJob } from "./test-history";
import { computeWorkloads, getWorkloadDetail, getWorkloads } from "./workloads";

const NOW = "2026-10-08T00:00:00.000Z";
const END_YESTERDAY = "2026-10-07T13:00:00.000Z";
const IN_A_WEEK = "2026-10-15T13:00:00.000Z";
const AT = "2026-10-01T00:00:00.000Z";

let db: TestDb;
let ids: SeedIds;

beforeEach(() => {
  fakeClock.set(NOW);
  db = makeTestDb();
  ids = seedMinimalOrg(db, { at: "2026-09-01T00:00:00.000Z", settings: { maxActiveJobsPerEditor: 4 } });
});

afterEach(() => fakeClock.reset());

const job = (o: Parameters<typeof insertJobFixture>[2]) => insertJobFixture(db, ids, { at: AT, dueDate: IN_A_WEEK, ...o }).job;
const rowFor = (userId: string) => computeWorkloads(db, contextFor(db, ids.users.manager)).rows.find((r) => r.editor.id === userId);

describe("workload bands", () => {
  it("healthy below the near-capacity ratio, near_capacity at ≥ 0.7, overloaded at ≥ 1.0", () => {
    db.update(users).set({ capacityHoursPerWeek: 10 }).where(eq(users.id, ids.users.editor1)).run();
    job({ statusKey: "in_progress", estimatedHours: 6 });
    let r = rowFor(ids.users.editor1);
    expect(r?.score).toBeCloseTo(6);
    expect(r?.band).toBe("healthy");
    expect(r?.ratio).toBeCloseTo(0.6);

    job({ statusKey: "submitted", estimatedHours: 4 }); // reviewer-held → weight 0.25 → +1
    r = rowFor(ids.users.editor1);
    expect(r?.score).toBeCloseTo(7);
    expect(r?.band).toBe("near_capacity");
    expect(r?.awaitingReview).toBe(1);
    expect(r?.editor.capacityHoursPerWeek).toBe(10);

    job({ statusKey: "accepted", estimatedHours: 2, priority: "urgent" }); // 2 × 1.6 = 3.2
    r = rowFor(ids.users.editor1);
    expect(r?.score).toBeCloseTo(10.2);
    expect(r?.band).toBe("overloaded");
    expect(r?.bandReason).toBe("ratio");
  });

  it("forces overloaded at max_active_jobs_per_editor and at 3 overdue jobs", () => {
    for (let i = 0; i < 4; i++) job({ statusKey: "in_progress", editorId: ids.users.editor2, estimatedHours: 0.5 });
    const r2 = rowFor(ids.users.editor2);
    expect(r2?.active).toBe(4);
    expect(r2?.band).toBe("overloaded");
    expect(r2?.bandReason).toBe("max_active");

    for (let i = 0; i < 3; i++) job({ statusKey: "revision", dueDate: END_YESTERDAY, estimatedHours: 0.5 });
    const r1 = rowFor(ids.users.editor1);
    expect(r1?.overdue).toBe(3);
    expect(r1?.revision).toBe(3);
    expect(r1?.bandReason).toBe("overdue_cap");
  });

  it("flags an inactive editor still holding open jobs; drops inactive editors with none", () => {
    expect(rowFor(ids.users.inactiveEditor)).toBeUndefined();
    job({ statusKey: "in_progress", editorId: ids.users.inactiveEditor });
    const r = rowFor(ids.users.inactiveEditor);
    expect(r).toBeDefined();
    expect(r?.editor.isActive).toBe(false);
    expect(r?.band).toBe("overloaded");
    expect(r?.bandReason).toBe("inactive");
    // listed first (overloaded sorts before healthy)
    expect(computeWorkloads(db, contextFor(db, ids.users.manager)).rows[0].editor.id).toBe(ids.users.inactiveEditor);
  });

  it("counts completed this week once even after reopen + re-complete; approved/delivered are not workload", () => {
    const a = job({ statusKey: "completed", at: "2026-09-29T00:00:00.000Z" });
    moveJob(db, ids, a.id, "in_progress", "2026-10-02T00:00:00.000Z", { isReopen: true });
    moveJob(db, ids, a.id, "approved", "2026-10-05T00:00:00.000Z");
    moveJob(db, ids, a.id, "completed", "2026-10-06T00:00:00.000Z");
    job({ statusKey: "approved" });
    const r = rowFor(ids.users.editor1);
    expect(r?.completedThisWeek).toBe(1);
    expect(r?.completedThisMonth).toBe(1);
    expect(r?.active).toBe(0);
  });
});

describe("getWorkloads / getWorkloadDetail permissions", () => {
  it("management sees every editor; an editor without the team flag sees only themself; photographers nothing", () => {
    job({ statusKey: "in_progress" });
    expect(getWorkloads(db, contextFor(db, ids.users.manager)).map((r) => r.editor.id).sort()).toEqual([ids.users.editor1, ids.users.editor2].sort());
    expect(getWorkloads(db, contextFor(db, ids.users.editor2)).map((r) => r.editor.id)).toEqual([ids.users.editor2]);
    expect(getWorkloads(db, contextFor(db, ids.users.photographer1))).toEqual([]);
    db.update(users).set({ canViewTeamWorkloads: true }).where(eq(users.id, ids.users.photographer1)).run();
    expect(getWorkloads(db, contextFor(db, ids.users.photographer1))).toHaveLength(2);
  });

  it("detail: jobs, history and averages for management and self; others forbidden; foreign ids 404", () => {
    job({ statusKey: "in_progress", dueDate: END_YESTERDAY });
    const b = job({ statusKey: "in_progress", at: "2026-10-02T00:00:00.000Z" });
    moveJob(db, ids, b.id, "submitted", "2026-10-03T00:00:00.000Z");
    moveJob(db, ids, b.id, "approved", "2026-10-04T00:00:00.000Z");
    moveJob(db, ids, b.id, "completed", "2026-10-05T00:00:00.000Z");

    const d = getWorkloadDetail(db, contextFor(db, ids.users.manager), ids.users.editor1);
    expect(d.currentJobs).toHaveLength(1);
    expect(d.overdueJobs).toHaveLength(1);
    expect(d.recentCompleted.map((j) => j.id)).toEqual([b.id]);
    expect(d.avgTurnaroundSeconds).toBe(2 * 86_400);
    expect(d.avgEditingSeconds).toBe(86_400);
    expect(d.onTimePercent).toBe(100);
    expect(d.history).toHaveLength(30);
    expect(d.history[d.history.length - 1]).toMatchObject({ date: "2026-10-08", count: 1 });
    expect(d.secondsPerCategory.in_progress).toBe(86_400);

    expect(getWorkloadDetail(db, contextFor(db, ids.users.editor1), ids.users.editor1).editor.id).toBe(ids.users.editor1);
    expect(() => getWorkloadDetail(db, contextFor(db, ids.users.editor2), ids.users.editor1)).toThrow(ForbiddenError);

    const other = seedMinimalOrg(db, { slug: "other" });
    expect(() => getWorkloadDetail(db, contextFor(db, ids.users.manager), other.users.editor1)).toThrow(NotFoundError);
  });
});
