import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import type { BottleneckKind } from "@/lib/constants";
import { ForbiddenError } from "@/server/errors";
import { computeBottlenecks, getBottlenecks } from "./bottlenecks";
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
  });

  it("editor_overloaded: an editor in the overloaded band (max active) is reported with their jobs", () => {
    job({ statusKey: "in_progress", estimatedHours: 0.5 });
    job({ statusKey: "accepted", estimatedHours: 0.5 });
    expect(kinds()).not.toContain("editor_overloaded");
    job({ statusKey: "revision", estimatedHours: 0.5 });
    const a = alert("editor_overloaded");
    expect(a?.user?.id).toBe(ids.users.editor1);
    expect(a?.jobs).toHaveLength(3);
    expect(a?.href).toBe(`/team/users/${ids.users.editor1}`);
  });

  it("revision_spike: ≥ min revisions in the last 7 days with a zero baseline", () => {
    const j = job({ statusKey: "revision" });
    for (let n = 1; n <= 3; n++) addRevision(db, ids, j.id, n, ago(n * D));
    expect(kinds()).not.toContain("revision_spike");
    addRevision(db, ids, j.id, 4, ago(6 * D + 23 * H));
    const a = alert("revision_spike");
    expect(a?.count).toBe(4);
    expect(a?.jobs.map((x) => x.id)).toEqual([j.id]);
  });

  it("revision_spike: needs multiplier × baseline when earlier weeks had revisions", () => {
    const j = job({ statusKey: "revision" });
    let n = 0;
    // previous 4 weeks: 4 per week → baseline 4 → threshold 6
    for (let w = 1; w <= 4; w++) for (let k = 0; k < 4; k++) addRevision(db, ids, j.id, ++n, ago(w * 7 * D + (k + 1) * H));
    for (let k = 0; k < 5; k++) addRevision(db, ids, j.id, ++n, ago((k + 1) * H));
    expect(kinds()).not.toContain("revision_spike");
    addRevision(db, ids, j.id, ++n, ago(6 * H + 30 * 60_000));
    expect(alert("revision_spike")?.count).toBe(6);
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

  it("never includes another organisation's jobs", () => {
    const other = seedMinimalOrg(db, { slug: "other" });
    insertJobFixture(db, other, { statusKey: "new", dueDate: ahead(H) });
    expect(alerts()).toEqual([]);
  });
});
