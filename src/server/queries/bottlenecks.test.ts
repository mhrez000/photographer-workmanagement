import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { organisationSettings, users } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import type { BottleneckKind } from "@/lib/constants";
import { ForbiddenError } from "@/server/errors";
import { computeBottlenecks, getBottlenecks } from "./bottlenecks";
import { getDashboard } from "./dashboard";
import { listJobs } from "./jobs";
import { addRevision, setLastActivity } from "./test-history";

const NOW = "2026-10-08T00:00:00.000Z";
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
const ahead = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set(NOW);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db, {
    at: "2026-08-01T00:00:00.000Z",
    settings: {
      reviewBottleneckHours: 24,
      reviewBottleneckMinJobs: 3,
      maxActiveJobsPerEditor: 3,
      editingBottleneckMinDueSoon: 2,
      unassignedBacklogMin: 3,
      stalledDays: 5,
      revisionSpikeMinCount: 4,
      revisionSpikeMultiplier: 1.5,
    },
  });
});

afterEach(() => fakeClock.reset());

/** Fixtures default to "fresh" activity so the stalled rule stays quiet unless a test wants it. */
const job = async (o: Parameters<typeof insertJobFixture>[2]) => (await insertJobFixture(db, ids, { at: ago(H), ...o })).job;
const alerts = async () => computeBottlenecks(db, await contextFor(db, ids.users.manager));
const kinds = async () => (await alerts()).map((a) => a.kind);
const alert = async (k: BottleneckKind) => (await alerts()).find((a) => a.kind === k);

describe("bottleneck rules fire exactly at their thresholds", () => {
  it("review: n jobs waiting > reviewBottleneckHours, fires at n = min", async () => {
    for (let i = 0; i < 2; i++) await job({ statusKey: "submitted", at: ago(25 * H) });
    await job({ statusKey: "review", at: ago(23 * H) }); // not yet over the threshold
    expect(await kinds()).not.toContain("review");
    const third = await job({ statusKey: "resubmitted", at: ago(25 * H) });
    const a = await alert("review");
    expect(a?.count).toBe(3);
    expect(a?.jobs.map((j) => j.id)).toContain(third.id);
    expect(a?.message).toBe("Review bottleneck — 3 jobs waiting for review > 24h");
    // the drill-down reproduces the 3, not every reviewer-held job (4)
    const url = new URL(a?.href ?? "", "http://x");
    expect(url.searchParams.get("statusEnteredBefore")).toBe(ago(24 * H));
    const ctx = await contextFor(db, ids.users.manager);
    expect((await listJobs(db, ctx, Object.fromEntries(url.searchParams))).total).toBe(a?.count);
    expect((await listJobs(db, ctx, { quick: "awaiting_review" })).total).toBe(4);
  });

  it("editor_overloaded: an editor in the overloaded band (max active) is reported with their jobs", async () => {
    await job({ statusKey: "in_progress", estimatedHours: 0.5 });
    await job({ statusKey: "accepted", estimatedHours: 0.5 });
    expect(await kinds()).not.toContain("editor_overloaded");
    await job({ statusKey: "revision", estimatedHours: 0.5 });
    const a = await alert("editor_overloaded");
    expect(a?.user?.id).toBe(ids.users.editor1);
    expect(a?.jobs).toHaveLength(3);
    expect(a?.href).toBe(`/workspace/all?editorId=${ids.users.editor1}&statusCategory=assigned,accepted,in_progress,submitted,review,revision,resubmitted`);
  });

  it("editor_overloaded: approved / delivered jobs are not listed, so jobs.length === count === the linked list", async () => {
    await job({ statusKey: "in_progress", estimatedHours: 0.5 });
    await job({ statusKey: "accepted", estimatedHours: 0.5 });
    await job({ statusKey: "revision", estimatedHours: 0.5 });
    await job({ statusKey: "approved" });
    await job({ statusKey: "delivered" });
    const a = await alert("editor_overloaded");
    expect(a?.count).toBe(3);
    expect(a?.jobs).toHaveLength(3);
    const url = new URL(a?.href ?? "", "http://x");
    expect((await listJobs(db, await contextFor(db, ids.users.manager), Object.fromEntries(url.searchParams))).total).toBe(a?.count);
  });

  it("revision_spike: ≥ min revisions in the last 7 days with a zero baseline", async () => {
    const j = await job({ statusKey: "revision" });
    for (let n = 1; n <= 3; n++) await addRevision(db, ids, j.id, n, ago(n * D));
    expect(await kinds()).not.toContain("revision_spike");
    await addRevision(db, ids, j.id, 4, ago(6 * D + 23 * H));
    const a = await alert("revision_spike");
    // the rule fires on 4 requests; the alert counts the 1 job they were made on
    expect(a?.count).toBe(1);
    expect(a?.message).toBe("Revision bottleneck — 4 revision requests on 1 job in the last 7 days");
    expect(a?.jobs.map((x) => x.id)).toEqual([j.id]);
  });

  it("revision_spike: 3 requests on 2 jobs → count 2, and the revisedFrom link lists those 2 jobs", async () => {
    await db.update(organisationSettings).set({ revisionSpikeMinCount: 3 }).where(eq(organisationSettings.organisationId, ids.organisationId));
    const a1 = await job({ statusKey: "revision" });
    const a2 = await job({ statusKey: "completed" });
    const old = await job({ statusKey: "revision" });
    await job({ statusKey: "in_progress" });
    await addRevision(db, ids, a1.id, 1, ago(2 * D));
    await addRevision(db, ids, a1.id, 2, ago(1 * D));
    await addRevision(db, ids, a2.id, 1, ago(3 * D));
    await addRevision(db, ids, old.id, 1, ago(8 * D)); // outside the window
    const a = await alert("revision_spike");
    expect(a?.message).toContain("3 revision requests on 2 jobs");
    expect(a?.count).toBe(2);
    expect(a?.jobs.map((x) => x.id).sort()).toEqual([a1.id, a2.id].sort());
    const url = new URL(a?.href ?? "", "http://x");
    expect(url.searchParams.get("revisedFrom")).toBe(ago(7 * D));
    const list = await listJobs(db, await contextFor(db, ids.users.manager), Object.fromEntries(url.searchParams));
    expect(list.total).toBe(a?.count);
    expect(list.rows.map((r) => r.id).sort()).toEqual([a1.id, a2.id].sort());
    // revisedTo narrows the window
    const narrowed = await listJobs(db, await contextFor(db, ids.users.manager), { revisedFrom: ago(7 * D), revisedTo: ago(2 * D + 1) });
    expect(narrowed.rows.map((r) => r.id)).toEqual([a2.id]);
  });

  it("revision_spike: needs multiplier × baseline when earlier weeks had revisions", async () => {
    const j = await job({ statusKey: "revision" });
    let n = 0;
    // previous 4 weeks: 4 per week → baseline 4 → threshold 6
    for (let w = 1; w <= 4; w++) for (let k = 0; k < 4; k++) await addRevision(db, ids, j.id, ++n, ago(w * 7 * D + (k + 1) * H));
    for (let k = 0; k < 5; k++) await addRevision(db, ids, j.id, ++n, ago((k + 1) * H));
    expect(await kinds()).not.toContain("revision_spike");
    await addRevision(db, ids, j.id, ++n, ago(6 * H + 30 * 60_000));
    expect((await alert("revision_spike"))?.message).toBe("Revision bottleneck — 6 revision requests on 1 job in the last 7 days");
  });

  it("unassigned_backlog: fires at the minimum count, or for a single unassigned job due within 48h", async () => {
    await job({ statusKey: "new" });
    await job({ statusKey: "ready", dueDate: ahead(72 * H) });
    expect(await kinds()).not.toContain("unassigned_backlog");
    await job({ statusKey: "new" });
    expect(await alert("unassigned_backlog")).toMatchObject({ count: 3, severity: "warning" });
  });

  it("unassigned_backlog: a job due within 48h is critical on its own", async () => {
    await job({ statusKey: "new", dueDate: ahead(47 * H) });
    expect(await alert("unassigned_backlog")).toMatchObject({ count: 1, severity: "critical" });
  });

  it("stalled: active, not paused, last activity older than stalledDays", async () => {
    const a = await job({ statusKey: "in_progress" });
    const b = await job({ statusKey: "in_progress", isPaused: true });
    const c = await job({ statusKey: "completed" });
    await setLastActivity(db, a.id, ago(4 * D));
    await setLastActivity(db, b.id, ago(10 * D));
    await setLastActivity(db, c.id, ago(10 * D));
    expect(await kinds()).not.toContain("stalled");
    await setLastActivity(db, a.id, ago(5 * D + 1000));
    expect((await alert("stalled"))?.jobs.map((j) => j.id)).toEqual([a.id]);
  });

  it("editor_unavailable: active jobs held by a deactivated editor", async () => {
    await job({ statusKey: "completed", editorId: ids.users.inactiveEditor });
    expect(await kinds()).not.toContain("editor_unavailable");
    const j = await job({ statusKey: "in_progress", editorId: ids.users.inactiveEditor });
    const a = await alert("editor_unavailable");
    expect(a).toMatchObject({ count: 1, severity: "critical" });
    expect(a?.jobs[0].id).toBe(j.id);
    // reported as unavailable, not as an overloaded editor
    expect((await alerts()).filter((x) => x.kind === "editor_overloaded" && x.user?.id === ids.users.inactiveEditor)).toEqual([]);
  });

  it("review_overdue: reviewer-held jobs past their review deadline", async () => {
    await job({ statusKey: "submitted", reviewDueDate: ahead(H) });
    await job({ statusKey: "in_progress", reviewDueDate: ago(H) }); // not reviewer-held
    expect(await kinds()).not.toContain("review_overdue");
    await job({ statusKey: "review", reviewDueDate: ago(1000) });
    expect((await alert("review_overdue"))?.count).toBe(1);
  });

  it("returns nothing for a quiet organisation", async () => {
    await job({ statusKey: "in_progress", dueDate: ahead(10 * D) });
    expect(await alerts()).toEqual([]);
  });
});

describe("getBottlenecks permissions", () => {
  it("management and analytics photographers may view; editors may not", async () => {
    expect(await getBottlenecks(db, await contextFor(db, ids.users.owner))).toEqual([]);
    await expect(getBottlenecks(db, await contextFor(db, ids.users.editor1))).rejects.toThrow(ForbiddenError);
    await expect(getBottlenecks(db, await contextFor(db, ids.users.photographer1))).rejects.toThrow(ForbiddenError);
    await db.update(users).set({ canViewAnalytics: true }).where(eq(users.id, ids.users.photographer1));
    expect(await getBottlenecks(db, await contextFor(db, ids.users.photographer1))).toEqual([]);
  });

  it("non-management viewers only receive job refs they can open; counts stay org-wide", async () => {
    await db.update(users).set({ canViewAnalytics: true }).where(eq(users.id, ids.users.photographer1));
    const p2 = { photographerId: ids.users.photographer2, createdByUserId: ids.users.photographer2 };
    const mine = [await job({ statusKey: "new" }), await job({ statusKey: "ready" })];
    const theirs = [await job({ statusKey: "new", ...p2 }), await job({ statusKey: "new", ...p2 }), await job({ statusKey: "ready", ...p2 })];
    const p1 = await contextFor(db, ids.users.photographer1);
    const visibleIds = new Set((await listJobs(db, p1, { includeCancelled: "1", limit: "200" })).rows.map((r) => r.id));
    expect(theirs.every((j) => !visibleIds.has(j.id))).toBe(true);

    const full = await computeBottlenecks(db, p1);
    const scoped = await getBottlenecks(db, p1);
    expect(scoped.map((a) => a.kind)).toEqual(full.map((a) => a.kind));
    for (const [i, a] of scoped.entries()) {
      expect(a.jobs.every((j) => visibleIds.has(j.id))).toBe(true);
      expect(a.count).toBe(full[i].count);
      expect(a.hiddenJobCount).toBe(full[i].jobs.length - a.jobs.length);
    }
    const backlog = scoped.find((a) => a.kind === "unassigned_backlog");
    expect(backlog?.count).toBe(5);
    expect(backlog?.jobs.map((j) => j.id).sort()).toEqual(mine.map((j) => j.id).sort());
    expect(backlog?.hiddenJobCount).toBe(3);
    // the dashboard payload is scoped the same way
    const dash = (await getDashboard(db, p1)).bottlenecks.find((a) => a.kind === "unassigned_backlog");
    expect(dash?.jobs.map((j) => j.id).sort()).toEqual(mine.map((j) => j.id).sort());
    expect(dash?.hiddenJobCount).toBe(3);
    // management still gets every ref
    const m = (await getBottlenecks(db, await contextFor(db, ids.users.manager))).find((a) => a.kind === "unassigned_backlog");
    expect(m?.jobs).toHaveLength(5);
    expect(m?.hiddenJobCount).toBe(0);
  });

  it("never includes another organisation's jobs", async () => {
    const other = await seedMinimalOrg(db, { slug: "other" });
    await insertJobFixture(db, other, { statusKey: "new", dueDate: ahead(H) });
    expect(await alerts()).toEqual([]);
  });
});
