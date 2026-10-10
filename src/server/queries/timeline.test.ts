import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jobRevisions, jobStatusTransitions } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type JobFixtureOptions, type SeedIds, type TestDb } from "@/db/test-db";
import type { StatusCategory } from "@/lib/constants";
import {
  QUEUE_STAGE_FLOOR_SECONDS,
  getJobTimelineRow,
  getTimelineRows,
  isSlowStage,
  measuredStageSeconds,
  median,
  orgCategoryBaselines,
  stageBaselines,
  type StageJobDates,
} from "./timeline";

const H = 3600;
const DAY = 24 * H;
const NOW = "2026-10-08T00:00:00.000Z";
const iso = (ms: number) => new Date(ms).toISOString();
const ago = (seconds: number) => iso(Date.parse(NOW) - seconds * 1000);
const NO_DATES: StageJobDates = { shootDate: null, dueDate: null, reviewDueDate: null, deliveryDueDate: null };
const stage = (toCategory: StatusCategory, startSecondsAgo: number, lengthSeconds: number | null) => ({
  toCategory,
  enteredAt: ago(startSecondsAgo),
  exitedAt: lengthSeconds === null ? null : ago(startSecondsAgo - lengthSeconds),
});

describe("slow-stage rule (pure)", () => {
  it("uses the median, floored at 24 h for queue stages", async () => {
    expect(median([1, 9, 3])).toBe(3);
    expect(median([1, 2, 3, 100])).toBe(2.5);
    expect(median([])).toBe(0);
    const b = stageBaselines({
      assigned: Array.from({ length: 40 }, () => 2 * H), // many short waits
      in_progress: [DAY, DAY, DAY, 30 * DAY], // long tail does not drag the baseline up
      new: [3 * H],
      delivered: [3 * H],
    });
    expect(b.assigned).toBe(QUEUE_STAGE_FLOOR_SECONDS);
    expect(b.in_progress).toBe(DAY);
    expect(b.new).toBeUndefined();
    expect(b.delivered).toBeUndefined();
  });

  it("does not flag a 10 h assigned stage when assigned stages are usually short", async () => {
    const b = stageBaselines({ assigned: Array.from({ length: 50 }, (_, i) => (1 + (i % 4)) * H) });
    expect(isSlowStage(stage("assigned", 20 * H, 10 * H), NO_DATES, b, NOW)).toBe(false);
    expect(isSlowStage(stage("assigned", 10 * H, null), NO_DATES, b, NOW)).toBe(false); // current, no deadline
    expect(isSlowStage(stage("assigned", 4 * DAY, 3 * DAY), NO_DATES, b, NOW)).toBe(true); // over 2 × 24 h floor
  });

  it("flags a 5-day in_progress stage when the median is 1 day", async () => {
    const b = stageBaselines({ in_progress: [DAY, DAY, DAY, 2 * DAY, 12 * H] });
    expect(b.in_progress).toBe(DAY);
    expect(isSlowStage(stage("in_progress", 6 * DAY, 5 * DAY), NO_DATES, b, NOW)).toBe(true);
    expect(isSlowStage(stage("in_progress", 5 * DAY, null), NO_DATES, b, NOW)).toBe(true);
    expect(isSlowStage(stage("in_progress", 2 * DAY, 36 * H), NO_DATES, b, NOW)).toBe(false);
  });

  it("never flags new, ready or delivered stages", async () => {
    const b = { new: H, ready: H, delivered: H };
    for (const c of ["new", "ready", "delivered"] as const) expect(isSlowStage(stage(c, 30 * DAY, 20 * DAY), NO_DATES, b, NOW)).toBe(false);
  });

  it("does not count an assignment's wait for a future shoot", async () => {
    const b = stageBaselines({ assigned: [2 * H] });
    const shootTomorrow = { ...NO_DATES, shootDate: iso(Date.parse(NOW) + DAY) };
    const shootTwoDaysAgo = { ...NO_DATES, shootDate: ago(2 * DAY) };
    // Assigned 10 days ago, shoot still in the future → nothing measured.
    expect(measuredStageSeconds(stage("assigned", 10 * DAY, null), shootTomorrow, NOW)).toBe(0);
    expect(isSlowStage(stage("assigned", 10 * DAY, null), shootTomorrow, b, NOW)).toBe(false);
    // Shoot happened 2 days ago → only those 2 days count (≤ 2 × 24 h, not slow); a closed pre-shoot stage is never slow.
    expect(measuredStageSeconds(stage("assigned", 10 * DAY, null), shootTwoDaysAgo, NOW)).toBe(2 * DAY);
    expect(isSlowStage(stage("assigned", 10 * DAY, null), shootTwoDaysAgo, b, NOW)).toBe(false);
    expect(isSlowStage(stage("assigned", 10 * DAY, 7 * DAY), shootTwoDaysAgo, b, NOW)).toBe(false);
  });

  it("flags a current stage past the deadline it works towards, but not a closed one", async () => {
    const b = stageBaselines({ in_progress: [DAY], review: [DAY], revision: [DAY], approved: [DAY] });
    const pastEditingDue = { ...NO_DATES, dueDate: ago(H) };
    expect(isSlowStage(stage("in_progress", 3 * H, null), pastEditingDue, b, NOW)).toBe(true);
    expect(isSlowStage(stage("in_progress", 5 * H, 3 * H), pastEditingDue, b, NOW)).toBe(false);
    // Review stages read the review due date, not the editing deadline.
    expect(isSlowStage(stage("review", 3 * H, null), pastEditingDue, b, NOW)).toBe(false);
    expect(isSlowStage(stage("review", 3 * H, null), { ...NO_DATES, reviewDueDate: ago(H) }, b, NOW)).toBe(true);
    // Revision stages read the open revision's due date.
    expect(isSlowStage(stage("revision", 3 * H, null), pastEditingDue, b, NOW)).toBe(false);
    expect(isSlowStage(stage("revision", 3 * H, null), { ...NO_DATES, openRevisionDueDate: ago(H) }, b, NOW)).toBe(true);
    expect(isSlowStage(stage("approved", 3 * H, null), { ...NO_DATES, deliveryDueDate: ago(H) }, b, NOW)).toBe(true);
  });
});

describe("timeline query slow stages", () => {
  let db: TestDb;
  let ids: SeedIds;
  beforeEach(async () => {
    fakeClock.set(NOW);
    db = await makeTestDb();
    ids = await seedMinimalOrg(db);
  });
  afterEach(async () => fakeClock.reset());
  const job = async (opts: JobFixtureOptions) => await insertJobFixture(db, ids, opts);
  let nextSeq = 10;
  const history = async (jobId: string, category: StatusCategory, seconds: number[]) => {
    const base = nextSeq;
    await db.insert(jobStatusTransitions).values(
      seconds.map((s, i) => ({
        organisationId: ids.organisationId,
        jobId,
        sequence: base + i,
        kind: "transition" as const,
        toStatusId: ids.statuses[category === "assigned" ? "assigned" : "in_progress"],
        toCategory: category,
        statusName: category,
        enteredAt: "2026-09-01T00:00:00.000Z",
        exitedAt: iso(Date.parse("2026-09-01T00:00:00.000Z") + s * 1000),
        durationSeconds: s,
      })),
    );
    nextSeq += seconds.length;
  };

  it("baselines are medians and drive isBottleneck on the board", async () => {
    const hist = await job({ statusKey: "completed", at: "2026-08-30T00:00:00.000Z" });
    await history(
      hist.job.id,
      "assigned",
      Array.from({ length: 30 }, () => 3 * H),
    );
    await history(
      hist.job.id,
      "in_progress",
      Array.from({ length: 9 }, (_, i) => (i === 8 ? 40 * DAY : DAY)),
    );
    expect(await orgCategoryBaselines(db, await contextFor(db, ids.users.owner))).toMatchObject({ assigned: QUEUE_STAGE_FLOOR_SECONDS, in_progress: DAY });

    const queued = await job({ statusKey: "assigned", at: ago(10 * H) }); // 10 h in assigned: not slow
    const editing = await job({ statusKey: "in_progress", at: ago(5 * DAY) }); // 5 days editing vs usual 1 day: slow
    const rows = await getTimelineRows(db, await contextFor(db, ids.users.owner), { from: "2026-09-25", to: "2026-10-10" });
    const seg = (id: string) => rows.find((r) => r.job.id === id)?.segments.at(-1);
    expect(seg(queued.job.id)).toMatchObject({ category: "assigned", isBottleneck: false });
    expect(seg(editing.job.id)).toMatchObject({ category: "in_progress", isBottleneck: true });
  });

  it("search, current editor, photographer and priority filter in SQL (before the row cap)", async () => {
    const a = await job({
      statusKey: "in_progress",
      at: ago(2 * DAY),
      name: "Zebracrossing twilight",
      editorId: ids.users.editor1,
      photographerId: ids.users.photographer2,
      priority: "urgent",
    });
    const b = await job({
      statusKey: "in_progress",
      at: ago(2 * DAY),
      name: "Bondi apartment",
      editorId: ids.users.editor2,
      photographerId: ids.users.photographer1,
    });
    const ctx = await contextFor(db, ids.users.owner);
    const idsOf = async (input: Record<string, unknown>) =>
      (await getTimelineRows(db, ctx, { from: "2026-09-25", to: "2026-10-10", ...input })).map((r) => r.job.id);
    expect(await idsOf({})).toEqual(expect.arrayContaining([a.job.id, b.job.id]));
    expect(await idsOf({ q: "zebracross" })).toEqual([a.job.id]);
    expect(await idsOf({ q: a.job.jobNumber })).toEqual([a.job.id]);
    expect(await idsOf({ currentEditorId: [ids.users.editor2] })).toEqual([b.job.id]);
    expect(await idsOf({ photographerId: [ids.users.photographer1] })).toEqual([b.job.id]);
    expect(await idsOf({ priority: ["urgent"] })).toEqual([a.job.id]);
    expect(await idsOf({ q: "nothing matches this" })).toEqual([]);
  });

  it("a current revision stage is flagged by its open revision's due date", async () => {
    const j = await job({ statusKey: "revision", at: ago(2 * H), dueDate: ago(5 * DAY) });
    const ctx = await contextFor(db, ids.users.owner);
    expect((await getJobTimelineRow(db, ctx, j.job.id)).segments.at(-1)).toMatchObject({ category: "revision", isBottleneck: false });
    await db
      .insert(jobRevisions)
      .values({
        organisationId: ids.organisationId,
        jobId: j.job.id,
        revisionNumber: 1,
        requestedByUserId: ids.users.manager,
        reason: "Colour",
        description: "warmer",
        dueDate: ago(H),
      });
    expect((await getJobTimelineRow(db, ctx, j.job.id)).segments.at(-1)).toMatchObject({ category: "revision", isBottleneck: true });
  });
});
