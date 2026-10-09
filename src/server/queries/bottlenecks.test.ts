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

beforeEach(() => {
  fakeClock.set(NOW);
  db = makeTestDb();
  ids = seedMinimalOrg(db, {
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
const job = (o: Parameters<typeof insertJobFixture>[2]) => insertJobFixture(db, ids, { at: ago(H), ...o }).job;
const alerts = () => computeBottlenecks(db, contextFor(db, ids.users.manager));
const kinds = () => alerts().map((a) => a.kind);
const alert = (k: BottleneckKind) => alerts().find((a) => a.kind === k);

describe("bottleneck rules fire exactly at their thresholds", () => {
  it("review: n jobs waiting > reviewBottleneckHours, fires at n = min", () => {
    for (let i = 0; i < 2; i++) job({ statusKey: "submitted", at: ago(25 * H) });
    job({ statusKey: "review", at: ago(23 * H) }); // not yet over the threshold
    expect(kinds()).not.toContain("review");
    const third = job({ statusKey: "resubmitted", at: ago(25 * H) });
    const a = alert("review");
    expect(a?.count).toBe(3);
    expect(a?.jobs.map((j) => j.id)).toContain(third.id);
    expect(a?.message).toBe("Review bottleneck — 3 jobs waiting for review > 24h");
    // the drill-down reproduces the 3, not every reviewer-held job (4)
    const url = new URL(a?.href ?? "", "http://x");
    expect(url.searchParams.get("statusEnteredBefore")).toBe(ago(24 * H));
    const ctx = contextFor(db, ids.users.manager);
    expect(listJobs(db, ctx, Object.fromEntries(url.searchParams)).total).toBe(a?.count);
    expect(listJobs(db, ctx, { quick: "awaiting_review" }).total).toBe(4);
  });

  it("editor_overloaded: an editor in the overloaded band (max active) is reported with their jobs", () => {
    job({ statusKey: "in_progress", estimatedHours: 0.5 });
    job({ statusKey: "accepted", estimatedHours: 0.5 });
    expect(kinds()).not.toContain("editor_overloaded");
    job({ statusKey: "revision", estimatedHours: 0.5 });
    const a = alert("editor_overloaded");
    expect(a?.user?.id).toBe(ids.users.editor1);
    expect(a?.jobs).toHaveLength(3);
    expect(a?.href).toBe(`/workspace/all?editorId=${ids.users.editor1}&statusCategory=assigned,accepted,in_progress,submitted,review,revision,resubmitted`);
  });

  it("editor_overloaded: approved / delivered jobs are not listed, so jobs.length === count === the linked list", () => {
    job({ statusKey: "in_progress", estimatedHours: 0.5 });
    job({ statusKey: "accepted", estimatedHours: 0.5 });
    job({ statusKey: "revision", estimatedHours: 0.5 });
    job({ statusKey: "approved" });
    job({ statusKey: "delivered" });
    const a = alert("editor_overloaded");
    expect(a?.count).toBe(3);
    expect(a?.jobs).toHaveLength(3);
    const url = new URL(a?.href ?? "", "http://x");
    expect(listJobs(db, contextFor(db, ids.users.manager), Object.fromEntries(url.searchParams)).total).toBe(a?.count);
  });

  it("revision_spike: ≥ min revisions in the last 7 days with a zero baseline", () => {
    const j = job({ statusKey: "revision" });
    for (let n = 1; n <= 3; n++) addRevision(db, ids, j.id, n, ago(n * D));
    expect(kinds()).not.toContain("revision_spike");
    addRevision(db, ids, j.id, 4, ago(6 * D + 23 * H));
    const a = alert("revision_spike");
    // the rule fires on 4 requests; the alert counts the 1 job they were made on
    expect(a?.count).toBe(1);
    expect(a?.message).toBe("Revision bottleneck — 4 revision requests on 1 job in the last 7 days");
    expect(a?.jobs.map((x) => x.id)).toEqual([j.id]);
  });

  it("revision_spike: 3 requests on 2 jobs → count 2, and the revisedFrom link lists those 2 jobs", () => {
    db.update(organisationSettings).set({ revisionSpikeMinCount: 3 }).where(eq(organisationSettings.organisationId, ids.organisationId)).run();
    const a1 = job({ statusKey: "revision" });
    const a2 = job({ statusKey: "completed" });
    const old = job({ statusKey: "revision" });
    job({ statusKey: "in_progress" });
    addRevision(db, ids, a1.id, 1, ago(2 * D));
    addRevision(db, ids, a1.id, 2, ago(1 * D));
    addRevision(db, ids, a2.id, 1, ago(3 * D));
    addRevision(db, ids, old.id, 1, ago(8 * D)); // outside the window
    const a = alert("revision_spike");
    expect(a?.message).toContain("3 revision requests on 2 jobs");
    expect(a?.count).toBe(2);
    expect(a?.jobs.map((x) => x.id).sort()).toEqual([a1.id, a2.id].sort());
    const url = new URL(a?.href ?? "", "http://x");
    expect(url.searchParams.get("revisedFrom")).toBe(ago(7 * D));
    const list = listJobs(db, contextFor(db, ids.users.manager), Object.fromEntries(url.searchParams));
    expect(list.total).toBe(a?.count);
    expect(list.rows.map((r) => r.id).sort()).toEqual([a1.id, a2.id].sort());
    // revisedTo narrows the window
    expect(listJobs(db, contextFor(db, ids.users.manager), { revisedFrom: ago(7 * D), revisedTo: ago(2 * D + 1) }).rows.map((r) => r.id)).toEqual([a2.id]);
  });

  it("revision_spike: needs multiplier × baseline when earlier weeks had revisions", () => {
    const j = job({ statusKey: "revision" });
    let n = 0;
    // previous 4 weeks: 4 per week → baseline 4 → threshold 6
    for (let w = 1; w <= 4; w++) for (let k = 0; k < 4; k++) addRevision(db, ids, j.id, ++n, ago(w * 7 * D + (k + 1) * H));
    for (let k = 0; k < 5; k++) addRevision(db, ids, j.id, ++n, ago((k + 1) * H));
    expect(kinds()).not.toContain("revision_spike");
    addRevision(db, ids, j.id, ++n, ago(6 * H + 30 * 60_000));
    expect(alert("revision_spike")?.message).toBe("Revision bottleneck — 6 revision requests on 1 job in the last 7 days");
  });

  it("unassigned_backlog: fires at the minimum count, or for a single unassigned job due within 48h", () => {
    job({ statusKey: "new" });
    job({ statusKey: "ready", dueDate: ahead(72 * H) });
    expect(kinds()).not.toContain("unassigned_backlog");
    job({ statusKey: "new" });
    expect(alert("unassigned_backlog")).toMatchObject({ count: 3, severity: "warning" });
  });

  it("unassigned_backlog: a job due within 48h is critical on its own", () => {
    job({ statusKey: "new", dueDate: ahead(47 * H) });
    expect(alert("unassigned_backlog")).toMatchObject({ count: 1, severity: "critical" });
  });

  it("stalled: active, not paused, last activity older than stalledDays", () => {
    const a = job({ statusKey: "in_progress" });
    const b = job({ statusKey: "in_progress", isPaused: true });
    const c = job({ statusKey: "completed" });
    setLastActivity(db, a.id, ago(4 * D));
    setLastActivity(db, b.id, ago(10 * D));
    setLastActivity(db, c.id, ago(10 * D));
    expect(kinds()).not.toContain("stalled");
    setLastActivity(db, a.id, ago(5 * D + 1000));
    expect(alert("stalled")?.jobs.map((j) => j.id)).toEqual([a.id]);
  });

  it("editor_unavailable: active jobs held by a deactivated editor", () => {
    job({ statusKey: "completed", editorId: ids.users.inactiveEditor });
    expect(kinds()).not.toContain("editor_unavailable");
    const j = job({ statusKey: "in_progress", editorId: ids.users.inactiveEditor });
    const a = alert("editor_unavailable");
    expect(a).toMatchObject({ count: 1, severity: "critical" });
    expect(a?.jobs[0].id).toBe(j.id);
    // reported as unavailable, not as an overloaded editor
    expect(alerts().filter((x) => x.kind === "editor_overloaded" && x.user?.id === ids.users.inactiveEditor)).toEqual([]);
  });

  it("review_overdue: reviewer-held jobs past their review deadline", () => {
    job({ statusKey: "submitted", reviewDueDate: ahead(H) });
    job({ statusKey: "in_progress", reviewDueDate: ago(H) }); // not reviewer-held
    expect(kinds()).not.toContain("review_overdue");
    job({ statusKey: "review", reviewDueDate: ago(1000) });
    expect(alert("review_overdue")?.count).toBe(1);
  });

  it("returns nothing for a quiet organisation", () => {
    job({ statusKey: "in_progress", dueDate: ahead(10 * D) });
    expect(alerts()).toEqual([]);
  });
});

describe("getBottlenecks permissions", () => {
  it("management and analytics photographers may view; editors may not", () => {
    expect(getBottlenecks(db, contextFor(db, ids.users.owner))).toEqual([]);
    expect(() => getBottlenecks(db, contextFor(db, ids.users.editor1))).toThrow(ForbiddenError);
    expect(() => getBottlenecks(db, contextFor(db, ids.users.photographer1))).toThrow(ForbiddenError);
    db.update(users).set({ canViewAnalytics: true }).where(eq(users.id, ids.users.photographer1)).run();
    expect(getBottlenecks(db, contextFor(db, ids.users.photographer1))).toEqual([]);
  });

  it("non-management viewers only receive job refs they can open; counts stay org-wide", () => {
    db.update(users).set({ canViewAnalytics: true }).where(eq(users.id, ids.users.photographer1)).run();
    const p2 = { photographerId: ids.users.photographer2, createdByUserId: ids.users.photographer2 };
    const mine = [job({ statusKey: "new" }), job({ statusKey: "ready" })];
    const theirs = [job({ statusKey: "new", ...p2 }), job({ statusKey: "new", ...p2 }), job({ statusKey: "ready", ...p2 })];
    const p1 = contextFor(db, ids.users.photographer1);
    const visibleIds = new Set(listJobs(db, p1, { includeCancelled: "1", limit: "200" }).rows.map((r) => r.id));
    expect(theirs.every((j) => !visibleIds.has(j.id))).toBe(true);

    const full = computeBottlenecks(db, p1);
    const scoped = getBottlenecks(db, p1);
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
    const dash = getDashboard(db, p1).bottlenecks.find((a) => a.kind === "unassigned_backlog");
    expect(dash?.jobs.map((j) => j.id).sort()).toEqual(mine.map((j) => j.id).sort());
    expect(dash?.hiddenJobCount).toBe(3);
    // management still gets every ref
    const m = getBottlenecks(db, contextFor(db, ids.users.manager)).find((a) => a.kind === "unassigned_backlog");
    expect(m?.jobs).toHaveLength(5);
    expect(m?.hiddenJobCount).toBe(0);
  });

  it("never includes another organisation's jobs", () => {
    const other = seedMinimalOrg(db, { slug: "other" });
    insertJobFixture(db, other, { statusKey: "new", dueDate: ahead(H) });
    expect(alerts()).toEqual([]);
  });
});
