import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { jobs, users } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import { CATEGORY_GROUPS } from "@/lib/constants";
import type { Job } from "@/lib/types";
import { getDashboardLayout } from "@/server/services/dashboards";
import { KPI_DEFS } from "@/components/dashboard/kpi-strip";
import { getDashboard, getKpis } from "./dashboard";
import { listJobs } from "./jobs";
import { moveJob } from "./test-history";

// Thu 8 Oct 2026, 11:00 in Sydney (AEDT, +11). Week = Mon 5 Oct – Sun 11 Oct.
const NOW = "2026-10-08T00:00:00.000Z";
const END_TODAY = "2026-10-08T12:59:59.999Z"; // stored deadline for "today" (last ms of the civil day)
const END_YESTERDAY = "2026-10-07T12:59:59.999Z";
const END_TOMORROW = "2026-10-09T12:59:59.999Z";
const WEEK_START = "2026-10-04T13:00:00.000Z";
const WEEK_END = "2026-10-11T13:00:00.000Z";

let db: TestDb;
let ids: SeedIds;

/** Brute-force KPI counts straight off the jobs table (independent of the query code). */
function bruteForce(rows: Job[]) {
  const active = rows.filter((j) => CATEGORY_GROUPS.ACTIVE.includes(j.statusCategory));
  const bound = rows.filter((j) => CATEGORY_GROUPS.DEADLINE_BOUND.includes(j.statusCategory));
  return {
    active: active.length,
    dueToday: bound.filter((j) => j.dueDate !== null && j.dueDate >= NOW && j.dueDate <= END_TODAY).length,
    overdue: bound.filter((j) => j.dueDate !== null && j.dueDate < NOW).length,
    awaitingEditor: rows.filter((j) => ["assigned", "accepted"].includes(j.statusCategory)).length,
    inEditing: rows.filter((j) => j.statusCategory === "in_progress").length,
    awaitingReview: rows.filter((j) => ["submitted", "review", "resubmitted"].includes(j.statusCategory)).length,
    revisionRequired: rows.filter((j) => j.statusCategory === "revision").length,
    completedThisWeek: rows.filter((j) => j.statusCategory === "completed" && j.completedAt !== null && j.completedAt >= WEEK_START && j.completedAt < WEEK_END)
      .length,
    unassigned: rows.filter((j) => ["new", "ready"].includes(j.statusCategory)).length,
    paused: active.filter((j) => j.isPaused).length,
    reviewOverdue: rows.filter((j) => ["submitted", "review", "resubmitted"].includes(j.statusCategory) && j.reviewDueDate !== null && j.reviewDueDate < NOW).length,
  };
}

let reopenedRecompletedId = "";
let reopenedOpenId = "";
let completedLastWeekId = "";

beforeEach(async () => {
  fakeClock.set(NOW);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db, { at: "2026-09-01T00:00:00.000Z" });
  const at = "2026-10-01T00:00:00.000Z";
  const f = async (o: Parameters<typeof insertJobFixture>[2]) => (await insertJobFixture(db, ids, { at, ...o })).job;
  await f({ statusKey: "new" });
  await f({ statusKey: "ready", dueDate: END_TODAY });
  await f({ statusKey: "assigned", dueDate: END_YESTERDAY });
  await f({ statusKey: "accepted", dueDate: END_TOMORROW });
  await f({ statusKey: "in_progress", dueDate: END_YESTERDAY, isPaused: true });
  await f({ statusKey: "in_progress", dueDate: END_TODAY });
  await f({ statusKey: "in_progress", dueDate: END_TODAY, editorId: ids.users.editor2 });
  await f({ statusKey: "submitted", reviewDueDate: "2026-10-07T00:00:00.000Z" });
  await f({ statusKey: "review", dueDate: END_TOMORROW });
  await f({ statusKey: "revision", dueDate: END_YESTERDAY });
  await f({ statusKey: "resubmitted" });
  await f({ statusKey: "approved", dueDate: END_YESTERDAY }); // done → never overdue
  await f({ statusKey: "delivered" });
  await f({ statusKey: "completed", at: "2026-10-06T01:00:00.000Z" }); // this week
  completedLastWeekId = (await f({ statusKey: "completed", at: "2026-09-30T01:00:00.000Z" })).id;
  await f({ statusKey: "cancelled" });

  // completed last week → reopened → re-completed this week: counts once, this week
  const a = await f({ statusKey: "completed", at: "2026-09-29T01:00:00.000Z" });
  await moveJob(db, ids, a.id, "in_progress", "2026-10-02T00:00:00.000Z", { isReopen: true });
  await moveJob(db, ids, a.id, "submitted", "2026-10-03T00:00:00.000Z");
  await moveJob(db, ids, a.id, "approved", "2026-10-05T00:00:00.000Z");
  await moveJob(db, ids, a.id, "completed", "2026-10-06T02:00:00.000Z");
  reopenedRecompletedId = a.id;

  // completed last week → reopened, still in revision: not completed this week
  const b = await f({ statusKey: "completed", at: "2026-09-29T02:00:00.000Z" });
  await moveJob(db, ids, b.id, "revision", "2026-10-07T00:00:00.000Z", { isReopen: true });
  reopenedOpenId = b.id;
});

afterEach(() => fakeClock.reset());

describe("getDashboard / KPIs", () => {
  it("management KPIs equal brute-force counts over every job", async () => {
    const ctx = await contextFor(db, ids.users.manager);
    const all = await db.select().from(jobs);
    const expected = bruteForce(all);
    const kpis = await getKpis(db, ctx);
    expect({ ...kpis, asOf: undefined, completedWeek: undefined }).toEqual({ ...expected, asOf: undefined });
    expect(kpis.asOf).toBe(NOW);
    expect(kpis.completedWeek).toEqual({ from: WEEK_START, to: WEEK_END });
    // sanity on the fixture design
    expect(expected.completedThisWeek).toBe(2);
    expect(expected.overdue).toBe(3);
    expect(expected.dueToday).toBe(3);
  });

  it("a job completed last week, reopened and re-completed this week counts this week only, once", async () => {
    const ctx = await contextFor(db, ids.users.owner);
    const d = await getDashboard(db, ctx);
    expect(d.kpis.completedThisWeek).toBe(2);
    const completedIds = d.recentCompleted.map((j) => j.id);
    expect(completedIds.filter((id) => id === reopenedRecompletedId)).toHaveLength(1);
    expect(completedIds).toContain(completedLastWeekId);
    expect(completedIds).not.toContain(reopenedOpenId);
    expect(d.kpis.revisionRequired).toBe(2);
  });

  it("the Completed-this-week drill-down (completedFrom/completedTo) lists exactly the KPI's jobs", async () => {
    for (const key of ["owner", "editor1"] as const) {
      const ctx = await contextFor(db, ids.users[key]);
      const kpis = await getKpis(db, ctx);
      const week = kpis.completedWeek;
      expect(week).toBeDefined();
      const list = await listJobs(db, ctx, { quick: "completed", completedFrom: week?.from, completedTo: week?.to, limit: "200" });
      expect(list.total).toBe(kpis.completedThisWeek);
    }
    const owner = await contextFor(db, ids.users.owner);
    const list = await listJobs(db, owner, { quick: "completed", completedFrom: WEEK_START, completedTo: WEEK_END });
    expect(list.total).toBe(2);
    expect(list.rows.map((r) => r.id)).toContain(reopenedRecompletedId);
    expect(list.rows.map((r) => r.id)).not.toContain(completedLastWeekId);
    // civil bounds: completedTo is an inclusive day (Mon 5 – Sun 11 Oct)
    expect((await listJobs(db, owner, { completedFrom: "2026-10-05", completedTo: "2026-10-11" })).total).toBe(2);
    // the KPI link carries the same bounds
    const href = KPI_DEFS.find((d) => d.key === "completedThisWeek")?.href;
    const k = await getKpis(db, owner);
    const url = new URL(typeof href === "function" ? href(k) : String(href), "http://x");
    expect((await listJobs(db, owner, Object.fromEntries(url.searchParams))).total).toBe(k.completedThisWeek);
  });

  it("due-today and overdue lists agree with the KPI counts and flags", async () => {
    const ctx = await contextFor(db, ids.users.manager);
    const d = await getDashboard(db, ctx);
    expect(d.variant).toBe("management");
    expect(d.dueToday).toHaveLength(d.kpis.dueToday);
    expect(d.overdue).toHaveLength(d.kpis.overdue);
    expect(d.dueToday.every((j) => j.isDueToday && !j.isOverdue)).toBe(true);
    expect(d.overdue.every((j) => j.isOverdue)).toBe(true);
    expect(d.workloads).not.toBeNull();
    expect(d.editorPerformance).not.toBeNull();
    expect(d.personal).toBeNull();
    expect(d.layout.widgets.map((w) => w.type)).toContain("team_workload");
  });

  it("editor dashboard is personal and only counts the editor's visible jobs", async () => {
    const ctx = await contextFor(db, ids.users.editor2);
    const mine = await db.select().from(jobs).where(eq(jobs.editorId, ids.users.editor2));
    const d = await getDashboard(db, ctx);
    expect(d.variant).toBe("personal");
    expect({ ...d.kpis, asOf: undefined, completedWeek: undefined }).toEqual({ ...bruteForce(mine), asOf: undefined });
    expect(d.kpis.active).toBe(1);
    expect(d.workloads).toBeNull(); // editors_see_team_workloads is off
    expect(d.bottlenecks).toEqual([]);
    expect(d.editorPerformance).toBeNull();
    expect(d.personal?.myWorkload?.editor.id).toBe(ids.users.editor2);
    expect(d.personal?.queuePreview.map((j) => j.editor?.id)).toEqual([ids.users.editor2]);
    expect(d.layout.widgets.map((w) => w.type)).toContain("my_workload");
  });

  it("photographer with no jobs sees zero KPIs; flags open team workloads", async () => {
    const ctx = await contextFor(db, ids.users.photographer2);
    const d = await getDashboard(db, ctx);
    expect(d.kpis.active).toBe(0);
    expect(d.dueToday).toEqual([]);
    expect(d.workloads).toBeNull();
    await db.update(users).set({ canViewTeamWorkloads: true, canViewAnalytics: true }).where(eq(users.id, ids.users.photographer2));
    const d2 = await getDashboard(db, await contextFor(db, ids.users.photographer2));
    expect(d2.workloads?.length).toBeGreaterThan(0);
    expect(Array.isArray(d2.bottlenecks)).toBe(true);
  });

  it("returns the same layout as the dashboard layout service (role default, allowed widgets only)", async () => {
    for (const key of ["editor1", "photographer1", "manager", "owner"] as const) {
      const ctx = await contextFor(db, ids.users[key]);
      expect((await getDashboard(db, ctx)).layout).toEqual((await getDashboardLayout(db, ctx)).layout);
    }
    const editorLayout = (await getDashboard(db, await contextFor(db, ids.users.editor1))).layout;
    expect(editorLayout.widgets[0].type).toBe("kpis");
    // an editor never gets widgets they may not load
    expect(editorLayout.widgets.some((w) => ["team_workload", "editor_performance", "bottlenecks", "revision_rate"].includes(w.type))).toBe(false);
  });
});
