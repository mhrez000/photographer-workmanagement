import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jobRevisions, jobStatusTransitions, notifications } from "@/db/schema";
import {
  addTeamFixture,
  contextFor,
  fakeClock,
  insertJobFixture,
  makeTestDb,
  seedMinimalOrg,
  type JobFixtureOptions,
  type SeedIds,
  type TestDb,
} from "@/db/test-db";
import { endOfCivilDayIso } from "@/lib/dates";
import { getCalendarEvents } from "./calendar";
import { listNotifications, unreadCount } from "./notifications";
import { getTeamWork } from "./teamWork";
import { getJobTimelineRow, getTimelineRows } from "./timeline";

const NOW = "2026-10-08T00:00:00.000Z"; // 11:00 Thu 8 Oct, Sydney
const due = (civil: string) => endOfCivilDayIso(civil, "Australia/Sydney");

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set(NOW);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(async () => fakeClock.reset());

const ctxOf = async (key: keyof SeedIds["users"]) => await contextFor(db, ids.users[key]);
const job = async (opts: JobFixtureOptions) => await insertJobFixture(db, ids, opts);

describe("getCalendarEvents", () => {
  it("emits one event per date kind on its civil day, with overdue flags, scoped and range-limited", async () => {
    const a = (
      await job({
        statusKey: "in_progress",
        shootDate: due("2026-10-05"),
        dueDate: due("2026-10-07"),
        reviewDueDate: due("2026-10-12"),
        deliveryDueDate: due("2026-10-20"),
      })
    ).job;
    await db
      .insert(jobRevisions)
      .values({
        organisationId: ids.organisationId,
        jobId: a.id,
        revisionNumber: 1,
        requestedByUserId: ids.users.manager,
        reason: "Colour",
        description: "warmer",
        dueDate: due("2026-10-09"),
      });
    await job({ statusKey: "cancelled", dueDate: due("2026-10-07") });
    await job({ statusKey: "in_progress", dueDate: due("2026-12-01") });

    const events = await getCalendarEvents(db, await ctxOf("owner"), { from: "2026-10-01", to: "2026-10-31" });
    expect(events.map((e) => [e.kind, e.isOverdue])).toEqual([
      ["shoot", false],
      ["due", true],
      ["revision_due", false],
      ["review_due", false],
      ["delivery_due", false],
    ]);
    expect(events.find((e) => e.kind === "revision_due")?.revisionNumber).toBe(1);
    // A civil range of one day includes that day's end-of-day deadline and nothing from the previous day.
    expect((await getCalendarEvents(db, await ctxOf("owner"), { from: "2026-10-07", to: "2026-10-07" })).map((e) => e.kind)).toEqual(["due"]);
    expect(await getCalendarEvents(db, await ctxOf("owner"), { from: "2026-10-08", to: "2026-10-08" })).toEqual([]);
    expect((await getCalendarEvents(db, await ctxOf("owner"), { from: "2026-10-01", to: "2026-10-31", kinds: "shoot" })).map((e) => e.kind)).toEqual(["shoot"]);
    expect(await getCalendarEvents(db, await ctxOf("editor2"), { from: "2026-10-01", to: "2026-10-31" })).toEqual([]);
  });
});

describe("getTimelineRows", () => {
  it("draws stage bars and flags stages longer than 2× the org average for the category", async () => {
    const slow = await job({ statusKey: "in_progress", editorId: ids.users.editor1, at: "2026-10-01T00:00:00.000Z" });
    const fast = await job({ statusKey: "in_progress", editorId: ids.users.editor2, photographerId: ids.users.photographer2 });
    // A completed job with one closed 1-day in_progress stage → org average for in_progress = 1 day.
    const hist = await job({ statusKey: "completed", at: "2026-09-21T00:00:00.000Z" });
    await db.insert(jobStatusTransitions).values({
      organisationId: ids.organisationId,
      jobId: hist.job.id,
      sequence: 0,
      kind: "transition",
      toStatusId: ids.statuses.in_progress,
      toCategory: "in_progress",
      statusName: "In Progress",
      enteredAt: "2026-09-20T00:00:00.000Z",
      exitedAt: "2026-09-21T00:00:00.000Z",
      durationSeconds: 86_400,
      editorIdAtEntry: ids.users.editor1,
    });

    const rows = await getTimelineRows(db, await ctxOf("owner"), { from: "2026-09-25", to: "2026-10-10" });
    const slowRow = rows.find((r) => r.job.id === slow.job.id);
    const fastRow = rows.find((r) => r.job.id === fast.job.id);
    expect(slowRow?.segments).toHaveLength(1);
    expect(slowRow?.segments[0]).toMatchObject({ category: "in_progress", isCurrent: true, editor: { id: ids.users.editor1 } });
    expect(slowRow?.segments[0].isBottleneck).toBe(true); // 7 days > 2 × 1 day
    expect(fastRow?.segments[0].isBottleneck).toBe(false);
    // Grouped by editor name: Ed Editor (editor2) before Eve Editor (editor1).
    expect(rows.map((r) => r.job.editor?.name)).toEqual(["Ed Editor", "Eve Editor"]);
    expect((await getTimelineRows(db, await ctxOf("editor1"), { from: "2026-09-25", to: "2026-10-10" })).map((r) => r.job.id)).toEqual([slow.job.id]);
    expect((await getJobTimelineRow(db, await ctxOf("owner"), slow.job.id)).segments).toHaveLength(1);
  });
});

describe("getTeamWork", () => {
  it("groups active jobs by editor with workload aggregates for management", async () => {
    await job({ statusKey: "in_progress", editorId: ids.users.editor1, estimatedHours: 10, dueDate: due("2026-10-07") });
    await job({ statusKey: "submitted", editorId: ids.users.editor1, estimatedHours: 4 });
    await job({ statusKey: "in_progress", editorId: ids.users.editor2, photographerId: ids.users.photographer2, createdByUserId: ids.users.photographer2 });
    await job({ statusKey: "completed", editorId: ids.users.editor2 });
    await job({ statusKey: "new", editorId: null });

    const groups = await getTeamWork(db, await ctxOf("manager"));
    expect(groups.map((g) => [g.user.name, g.jobs.length])).toEqual([
      ["Ed Editor", 1],
      ["Eve Editor", 2],
    ]);
    const eve = groups.find((g) => g.user.id === ids.users.editor1)?.workload;
    expect(eve).toMatchObject({ active: 2, inProgress: 1, awaitingReview: 1, overdue: 1 });
    // 10h × 1 (normal) × 1.5 (overdue) × 1 + 4h × 1 × 1 × 0.25 = 16
    expect(eve?.score).toBeCloseTo(16);
    expect(groups.find((g) => g.user.id === ids.users.editor2)?.workload?.completedThisWeek).toBe(1);

    // Editors see only themselves (and teammates); no workload aggregates for others without the flag.
    const mine = await getTeamWork(db, await ctxOf("editor1"));
    expect(mine.map((g) => g.user.id)).toEqual([ids.users.editor1]);
    expect(mine[0].workload?.active).toBe(2);
    await addTeamFixture(db, ids, { name: "Edit", memberIds: [ids.users.editor1, ids.users.editor2] });
    expect((await getTeamWork(db, await ctxOf("photographer2"), { role: "photographer" })).map((g) => g.user.id)).toEqual([ids.users.photographer2]);
  });
});

describe("listNotifications", () => {
  it("lists only the actor's notifications, newest first, with unread filter and cursor", async () => {
    const j = (await job({ statusKey: "in_progress" })).job;
    for (let i = 0; i < 3; i += 1) {
      fakeClock.advanceMinutes(1);
      await db.insert(notifications).values({
        organisationId: ids.organisationId,
        userId: ids.users.editor1,
        type: "comment_added",
        title: `N${i}`,
        jobId: j.id,
        actorUserId: ids.users.photographer1,
        linkPath: `/jobs/${j.id}`,
        createdAt: fakeClock.now(),
        readAt: i === 0 ? fakeClock.now() : null,
      });
    }
    await db
      .insert(notifications)
      .values({ organisationId: ids.organisationId, userId: ids.users.editor2, type: "comment_added", title: "other", linkPath: "/x" });

    const ctx = await ctxOf("editor1");
    const all = await listNotifications(db, ctx);
    expect(all.items.map((n) => n.title)).toEqual(["N2", "N1", "N0"]);
    expect(all.items[0]).toMatchObject({ job: { id: j.id }, actor: { id: ids.users.photographer1 }, readAt: null });
    expect((await listNotifications(db, ctx, { unread: "1" })).items.map((n) => n.title)).toEqual(["N2", "N1"]);
    const p1 = await listNotifications(db, ctx, { limit: 2 });
    expect((await listNotifications(db, ctx, { limit: 2, cursor: p1.nextCursor })).items.map((n) => n.title)).toEqual(["N0"]);
    expect(await unreadCount(db, ctx)).toBe(2);
  });
});
