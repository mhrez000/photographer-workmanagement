import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { getAnalyticsOverview, getEditorAnalytics, getMyAnalytics, trendBuckets } from "./analytics";
import { approvedJobsInRange } from "./metrics";
import { getPerformance } from "./performance";
import { addRevision, moveJob, reattribute } from "./test-history";

const NOW = "2026-10-08T00:00:00.000Z";
const H = 3_600_000;
const T0 = "2026-10-01T00:00:00.000Z";
const t = (hours: number) => new Date(Date.parse(T0) + hours * H).toISOString();
const RANGE = { range: "last_30_days" };

let db: TestDb;
let ids: SeedIds;
let reassignedId = "";

beforeEach(() => {
  fakeClock.set(NOW);
  db = makeTestDb();
  ids = seedMinimalOrg(db, { at: "2026-08-01T00:00:00.000Z" });

  // Job A: editor1 edits 10h, reassigned mid-stage to editor2 who edits 6h, submits, gets approved.
  const a = insertJobFixture(db, ids, { statusKey: "in_progress", at: T0, dueDate: t(48) }).job;
  reattribute(db, ids, a.id, ids.users.editor2, t(10));
  moveJob(db, ids, a.id, "submitted", t(16));
  moveJob(db, ids, a.id, "approved", t(20));
  reassignedId = a.id;

  // Job B: editor1 alone; 4h editing, 2h review, revision, approved late.
  const b = insertJobFixture(db, ids, { statusKey: "in_progress", at: t(0), dueDate: t(5) }).job;
  moveJob(db, ids, b.id, "submitted", t(4));
  addRevision(db, ids, b.id, 1, t(6));
  moveJob(db, ids, b.id, "approved", t(6));
});

afterEach(() => fakeClock.reset());

describe("per-editor attribution follows reattribution", () => {
  it("credits the approval to the editor holding the job at approval", () => {
    const ctx = contextFor(db, ids.users.manager);
    const approved = approvedJobsInRange(db, ctx, { from: T0, to: NOW }, { scope: "org" });
    expect(approved.find((j) => j.id === reassignedId)?.approvingEditorId).toBe(ids.users.editor2);
  });

  it("splits editing time between the two editors and computes turnaround from first entry", () => {
    const ctx = contextFor(db, ids.users.manager);
    const e2 = getEditorAnalytics(db, ctx, ids.users.editor2, RANGE);
    expect(e2.performance).toMatchObject({ approved: 1, avgEditingSeconds: 6 * 3600, avgTurnaroundSeconds: 20 * 3600, avgReviewSeconds: 4 * 3600 });
    expect(e2.stageAverages.find((s) => s.category === "in_progress")).toMatchObject({ avgSeconds: 6 * 3600, count: 1 });

    const e1 = getEditorAnalytics(db, ctx, ids.users.editor1, RANGE);
    // only job B is credited to editor1 (4h editing); job A's first 10h show in editor1's stage averages
    expect(e1.performance).toMatchObject({ approved: 1, avgEditingSeconds: 4 * 3600, revisionRate: 1, onTimePercent: 0 });
    expect(e1.stageAverages.find((s) => s.category === "in_progress")).toMatchObject({ avgSeconds: 7 * 3600, count: 2 });
  });

  it("performance and overview agree with the per-editor numbers", () => {
    const ctx = contextFor(db, ids.users.owner);
    const perf = getPerformance(db, ctx, RANGE);
    const byId = new Map(perf.editors.map((r) => [r.user.id, r]));
    expect(byId.get(ids.users.editor1)?.approved).toBe(1);
    expect(byId.get(ids.users.editor2)?.approved).toBe(1);
    expect(byId.get(ids.users.editor2)?.revisionRate).toBe(0);

    const o = getAnalyticsOverview(db, ctx, RANGE);
    expect(o.range.preset).toBe("last_30_days");
    expect(o.revisionRate).toBe(0.5);
    expect(o.onTimePercent).toBe(50);
    expect(o.avgTurnaroundSeconds).toBe(13 * 3600); // (20h + 6h) / 2
    expect(o.trend).toHaveLength(30);
    expect(o.trend.reduce((s, p) => s + p.created, 0)).toBe(2);
    expect(o.trend.reduce((s, p) => s + p.revisionsRequested, 0)).toBe(1);
    expect(o.editors?.length).toBe(2);
    expect(o.stageAverages?.find((s) => s.category === "submitted")?.count).toBe(2);
    expect(o.byJobType.find((x) => x.created === 2)?.avgTurnaroundSeconds).toBe(13 * 3600);
    expect(o.byClient).toEqual([{ client: { id: ids.clientId, name: "Harbour Realty" }, created: 2, completed: 0, overdue: 0 }]);
    expect(o.kpis.active).toBe(2);
    expect(o.completionRate).toBe(1);
  });
});

describe("analytics access", () => {
  it("analytics.view gates the overview; editors use My Performance", () => {
    expect(() => getAnalyticsOverview(db, contextFor(db, ids.users.editor1), RANGE)).toThrow(ForbiddenError);
    expect(() => getAnalyticsOverview(db, contextFor(db, ids.users.photographer1), RANGE)).toThrow(ForbiddenError);
    db.update(users).set({ canViewAnalytics: true }).where(eq(users.id, ids.users.photographer1)).run();
    expect(getAnalyticsOverview(db, contextFor(db, ids.users.photographer1), RANGE).completed).toBe(0);

    const me = getMyAnalytics(db, contextFor(db, ids.users.editor2), RANGE);
    expect(me.role).toBe("editor");
    expect(me.editor?.approved).toBe(1);
    expect(me.photographer).toBeNull();
    const pia = getMyAnalytics(db, contextFor(db, ids.users.photographer1), RANGE);
    expect(pia.photographer).toMatchObject({ created: 2, submitted: 2 });
  });

  it("editor analytics: self or management only; foreign ids 404", () => {
    expect(getEditorAnalytics(db, contextFor(db, ids.users.editor1), ids.users.editor1, RANGE).editor.id).toBe(ids.users.editor1);
    expect(() => getEditorAnalytics(db, contextFor(db, ids.users.editor1), ids.users.editor2, RANGE)).toThrow(ForbiddenError);
    const other = seedMinimalOrg(db, { slug: "other" });
    expect(() => getEditorAnalytics(db, contextFor(db, ids.users.manager), other.users.editor1, RANGE)).toThrow(NotFoundError);
  });

  it("trend buckets: daily up to 31 days, weekly beyond", () => {
    expect(trendBuckets({ from: "2026-09-08T14:00:00.000Z", to: "2026-10-08T13:00:00.000Z" }, "Australia/Sydney")).toHaveLength(30);
    const long = trendBuckets({ from: "2026-06-30T14:00:00.000Z", to: "2026-10-08T13:00:00.000Z" }, "Australia/Sydney");
    expect(long.length).toBe(15); // 100 days → 14 full weeks + a 2-day tail
    expect(long[long.length - 1].to).toBe("2026-10-08T13:00:00.000Z");
  });
});
