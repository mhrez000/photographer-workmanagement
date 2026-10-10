import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, setUserFlags, type SeedIds, type TestDb } from "@/db/test-db";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { moveJob } from "./test-history";
import { canOpenPersonPage, computeWorkloads, getUserCompletedWork, getWorkloadDetail, getWorkloads } from "./workloads";

const NOW = "2026-10-08T00:00:00.000Z";
const END_YESTERDAY = "2026-10-07T13:00:00.000Z";
const IN_A_WEEK = "2026-10-15T13:00:00.000Z";
const AT = "2026-10-01T00:00:00.000Z";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set(NOW);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db, { at: "2026-09-01T00:00:00.000Z", settings: { maxActiveJobsPerEditor: 4 } });
});

afterEach(() => fakeClock.reset());

const job = async (o: Parameters<typeof insertJobFixture>[2]) => (await insertJobFixture(db, ids, { at: AT, dueDate: IN_A_WEEK, ...o })).job;
const rowFor = async (userId: string) => (await computeWorkloads(db, await contextFor(db, ids.users.coAdmin))).rows.find((r) => r.editor.id === userId);

describe("workload bands", () => {
  it("healthy below the near-capacity ratio, near_capacity at ≥ 0.7, overloaded at ≥ 1.0", async () => {
    await db.update(users).set({ capacityHoursPerWeek: 10 }).where(eq(users.id, ids.users.editor1));
    await job({ statusKey: "in_progress", estimatedHours: 6 });
    let r = await rowFor(ids.users.editor1);
    expect(r?.score).toBeCloseTo(6);
    expect(r?.band).toBe("healthy");
    expect(r?.ratio).toBeCloseTo(0.6);

    await job({ statusKey: "submitted", estimatedHours: 4 }); // reviewer-held → weight 0.25 → +1
    r = await rowFor(ids.users.editor1);
    expect(r?.score).toBeCloseTo(7);
    expect(r?.band).toBe("near_capacity");
    expect(r?.awaitingReview).toBe(1);
    expect(r?.editor.capacityHoursPerWeek).toBe(10);

    await job({ statusKey: "accepted", estimatedHours: 2, priority: "urgent" }); // 2 × 1.6 = 3.2
    r = await rowFor(ids.users.editor1);
    expect(r?.score).toBeCloseTo(10.2);
    expect(r?.band).toBe("overloaded");
    expect(r?.bandReason).toBe("ratio");
  });

  it("forces overloaded at max_active_jobs_per_editor and at 3 overdue jobs", async () => {
    for (let i = 0; i < 4; i++) await job({ statusKey: "in_progress", editorId: ids.users.editor2, estimatedHours: 0.5 });
    const r2 = await rowFor(ids.users.editor2);
    expect(r2?.active).toBe(4);
    expect(r2?.band).toBe("overloaded");
    expect(r2?.bandReason).toBe("max_active");

    for (let i = 0; i < 3; i++) await job({ statusKey: "revision", dueDate: END_YESTERDAY, estimatedHours: 0.5 });
    const r1 = await rowFor(ids.users.editor1);
    expect(r1?.overdue).toBe(3);
    expect(r1?.revision).toBe(3);
    expect(r1?.bandReason).toBe("overdue_cap");
  });

  it("flags an inactive editor still holding open jobs; drops inactive editors with none", async () => {
    expect(await rowFor(ids.users.inactiveEditor)).toBeUndefined();
    await job({ statusKey: "in_progress", editorId: ids.users.inactiveEditor });
    const r = await rowFor(ids.users.inactiveEditor);
    expect(r).toBeDefined();
    expect(r?.editor.isActive).toBe(false);
    expect(r?.band).toBe("overloaded");
    expect(r?.bandReason).toBe("inactive");
    // listed first (overloaded sorts before healthy)
    expect((await computeWorkloads(db, await contextFor(db, ids.users.coAdmin))).rows[0].editor.id).toBe(ids.users.inactiveEditor);
  });

  it("counts completed this week once even after reopen + re-complete; approved/delivered are not workload", async () => {
    const a = await job({ statusKey: "completed", at: "2026-09-29T00:00:00.000Z" });
    await moveJob(db, ids, a.id, "in_progress", "2026-10-02T00:00:00.000Z", { isReopen: true });
    await moveJob(db, ids, a.id, "approved", "2026-10-05T00:00:00.000Z");
    await moveJob(db, ids, a.id, "completed", "2026-10-06T00:00:00.000Z");
    await job({ statusKey: "approved" });
    const r = await rowFor(ids.users.editor1);
    expect(r?.completedThisWeek).toBe(1);
    expect(r?.completedThisMonth).toBe(1);
    expect(r?.active).toBe(0);
  });
});

describe("getWorkloads / getWorkloadDetail permissions", () => {
  it("admins see every editor; an editor without the team flag sees only themself; photographers nothing", async () => {
    await job({ statusKey: "in_progress" });
    expect((await getWorkloads(db, await contextFor(db, ids.users.coAdmin))).map((r) => r.editor.id).sort()).toEqual([ids.users.editor1, ids.users.editor2].sort());
    expect((await getWorkloads(db, await contextFor(db, ids.users.editor2))).map((r) => r.editor.id)).toEqual([ids.users.editor2]);
    expect(await getWorkloads(db, await contextFor(db, ids.users.photographer1))).toEqual([]);
    await db.update(users).set({ canViewTeamWorkloads: true }).where(eq(users.id, ids.users.photographer1));
    expect(await getWorkloads(db, await contextFor(db, ids.users.photographer1))).toHaveLength(2);
  });

  it("detail: jobs, history and averages for admins and self; others forbidden; foreign ids 404", async () => {
    await job({ statusKey: "in_progress", dueDate: END_YESTERDAY });
    const b = await job({ statusKey: "in_progress", at: "2026-10-02T00:00:00.000Z" });
    await moveJob(db, ids, b.id, "submitted", "2026-10-03T00:00:00.000Z");
    await moveJob(db, ids, b.id, "approved", "2026-10-04T00:00:00.000Z");
    await moveJob(db, ids, b.id, "completed", "2026-10-05T00:00:00.000Z");

    const d = await getWorkloadDetail(db, await contextFor(db, ids.users.coAdmin), ids.users.editor1);
    expect(d.currentJobs).toHaveLength(1);
    expect(d.overdueJobs).toHaveLength(1);
    expect(d.recentCompleted.map((j) => j.id)).toEqual([b.id]);
    expect(d.avgTurnaroundSeconds).toBe(2 * 86_400);
    expect(d.avgEditingSeconds).toBe(86_400);
    expect(d.onTimePercent).toBe(100);
    expect(d.history).toHaveLength(30);
    expect(d.history[d.history.length - 1]).toMatchObject({ date: "2026-10-08", count: 1 });
    expect(d.secondsPerCategory.in_progress).toBe(86_400);

    expect((await getWorkloadDetail(db, await contextFor(db, ids.users.editor1), ids.users.editor1)).editor.id).toBe(ids.users.editor1);
    const editor2 = await contextFor(db, ids.users.editor2);
    await expect(getWorkloadDetail(db, editor2, ids.users.editor1)).rejects.toThrow(ForbiddenError);

    const other = await seedMinimalOrg(db, { slug: "other" });
    const coAdmin = await contextFor(db, ids.users.coAdmin);
    await expect(getWorkloadDetail(db, coAdmin, other.users.editor1)).rejects.toThrow(NotFoundError);
  });
});

describe("person pages (docs/ROLES.md §3.4)", () => {
  it("⚑workloads members open editor workload pages; photographer peers need ⚑analytics; clients never", async () => {
    await job({ statusKey: "in_progress" });
    const p1 = await contextFor(db, ids.users.photographer1);
    await expect(getWorkloadDetail(db, p1, ids.users.editor1)).rejects.toThrow(ForbiddenError);
    await setUserFlags(db, ids.users.photographer1, { canViewTeamWorkloads: true });
    expect((await getWorkloadDetail(db, await contextFor(db, ids.users.photographer1), ids.users.editor1)).currentJobs).toHaveLength(1);
    await expect(getWorkloadDetail(db, await contextFor(db, ids.users.photographer1), ids.users.photographer2)).rejects.toThrow(ForbiddenError);
    await setUserFlags(db, ids.users.photographer1, { canViewAnalytics: true });
    expect((await getWorkloadDetail(db, await contextFor(db, ids.users.photographer1), ids.users.photographer2)).editor.id).toBe(ids.users.photographer2);
    expect((await getUserCompletedWork(db, await contextFor(db, ids.users.photographer1), ids.users.editor1)).items).toEqual([]);
    // job lists inside a person page stay visibility-scoped
    const lead = await contextFor(db, ids.users.lead);
    await setUserFlags(db, ids.users.lead, { canViewAllJobs: false });
    expect((await getWorkloadDetail(db, await contextFor(db, ids.users.lead), ids.users.editor1)).currentJobs).toEqual([]);
    expect(lead.canViewAllJobs).toBe(true);

    const client = await contextFor(db, ids.users.client);
    await expect(getWorkloads(db, client)).rejects.toThrow(ForbiddenError);
    await expect(getWorkloadDetail(db, client, ids.users.editor1)).rejects.toThrow(ForbiddenError);
    await expect(getWorkloadDetail(db, client, ids.users.client)).rejects.toThrow(ForbiddenError);
    expect(canOpenPersonPage(await contextFor(db, ids.users.owner), { id: ids.users.client, role: "client" }, "workload")).toBe(false);
  });
});
