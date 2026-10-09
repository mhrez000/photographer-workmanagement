import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clients, jobAssignments, organisationSettings, projects, savedViews } from "@/db/schema";
import { addTeamFixture, contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type JobFixtureOptions, type SeedIds, type TestDb } from "@/db/test-db";
import { endOfCivilDayIso } from "@/lib/dates";
import { NotFoundError, ValidationError } from "@/server/errors";
import { decodeOffsetCursor, encodeOffsetCursor, getJobRowByNumber, listJobs } from "./jobs";

const TZ = "Australia/Sydney";
const NOW = "2026-10-08T00:00:00.000Z"; // Thu 8 Oct 2026, 11:00 Sydney
const due = (civil: string) => endOfCivilDayIso(civil, TZ);

let db: TestDb;
let ids: SeedIds;

beforeEach(() => {
  fakeClock.set(NOW);
  db = makeTestDb();
  ids = seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

const job = (opts: JobFixtureOptions = {}) => insertJobFixture(db, ids, opts).job;
const ctxOf = (key: keyof SeedIds["users"]) => contextFor(db, ids.users[key]);
const numbers = (rows: { jobNumber: string }[]) => rows.map((r) => r.jobNumber).sort();

function setSettings(values: Partial<typeof organisationSettings.$inferInsert>) {
  db.update(organisationSettings).set(values).where(eq(organisationSettings.organisationId, ids.organisationId)).run();
}

/** A = P1/E1 in progress, B = P2/E2 in progress, C = P2 new (created by P2, no editor). */
function threeJobs() {
  const a = job({ statusKey: "in_progress", photographerId: ids.users.photographer1, editorId: ids.users.editor1, name: "Alpha" });
  const b = job({ statusKey: "in_progress", photographerId: ids.users.photographer2, editorId: ids.users.editor2, createdByUserId: ids.users.photographer2, name: "Bravo" });
  const c = job({ statusKey: "new", photographerId: ids.users.photographer2, editorId: null, createdByUserId: ids.users.photographer2, name: "Charlie" });
  return { a, b, c };
}

describe("listJobs visibility", () => {
  it("scopes rows per role (own / assigned)", () => {
    const { a, b, c } = threeJobs();
    expect(numbers(listJobs(db, ctxOf("owner")).rows)).toEqual(numbers([a, b, c]));
    expect(numbers(listJobs(db, ctxOf("manager")).rows)).toEqual(numbers([a, b, c]));
    expect(numbers(listJobs(db, ctxOf("photographer1")).rows)).toEqual([a.jobNumber]);
    expect(numbers(listJobs(db, ctxOf("photographer2")).rows)).toEqual(numbers([b, c]));
    expect(numbers(listJobs(db, ctxOf("editor1")).rows)).toEqual([a.jobNumber]);
    expect(numbers(listJobs(db, ctxOf("editor2")).rows)).toEqual([b.jobNumber]);
  });

  it("photographers see teammates' jobs when photographers_see_team_jobs is on (default) and not when off", () => {
    const { a, b, c } = threeJobs();
    addTeamFixture(db, ids, { name: "Crew", memberIds: [ids.users.photographer1, ids.users.photographer2] });
    expect(numbers(listJobs(db, ctxOf("photographer1")).rows)).toEqual(numbers([a, b, c]));
    setSettings({ photographersSeeTeamJobs: false });
    expect(numbers(listJobs(db, ctxOf("photographer1")).rows)).toEqual([a.jobNumber]);
  });

  it("photographers_see_all_jobs shows the whole organisation", () => {
    const { a, b, c } = threeJobs();
    setSettings({ photographersSeeAllJobs: true });
    expect(numbers(listJobs(db, ctxOf("photographer1")).rows)).toEqual(numbers([a, b, c]));
  });

  it("editors see team jobs only with editors_see_team_jobs", () => {
    const { a, b } = threeJobs();
    addTeamFixture(db, ids, { name: "Editors", memberIds: [ids.users.editor1, ids.users.editor2] });
    expect(numbers(listJobs(db, ctxOf("editor1")).rows)).toEqual([a.jobNumber]);
    setSettings({ editorsSeeTeamJobs: true });
    expect(numbers(listJobs(db, ctxOf("editor1")).rows)).toEqual(numbers([a, b]));
  });

  it("archived teams grant nothing", () => {
    const { a } = threeJobs();
    addTeamFixture(db, ids, { name: "Old", memberIds: [ids.users.photographer1, ids.users.photographer2], archived: true });
    expect(numbers(listJobs(db, ctxOf("photographer1")).rows)).toEqual([a.jobNumber]);
  });

  it("past editors keep read visibility through job_assignments history", () => {
    const { a, b } = threeJobs();
    db.insert(jobAssignments)
      .values({
        organisationId: ids.organisationId,
        jobId: a.id,
        role: "editor",
        userId: ids.users.editor2,
        assignedAt: "2026-10-01T00:00:00.000Z",
        unassignedAt: "2026-10-02T00:00:00.000Z",
        unassignReason: "reassigned",
      })
      .run();
    expect(numbers(listJobs(db, ctxOf("editor2")).rows)).toEqual(numbers([a, b]));
  });

  it("never returns another organisation's rows", () => {
    const { a, b, c } = threeJobs();
    const other = seedMinimalOrg(db, { slug: "other" });
    const foreign = insertJobFixture(db, other, { statusKey: "in_progress", name: "Alpha foreign" }).job;
    const mine = listJobs(db, ctxOf("owner"));
    expect(numbers(mine.rows)).toEqual(numbers([a, b, c]));
    expect(mine.total).toBe(3);
    expect(listJobs(db, ctxOf("owner"), { q: "foreign" }).rows).toHaveLength(0);
    expect(listJobs(db, ctxOf("owner"), { clientId: other.clientId }).rows).toHaveLength(0);
    const theirs = listJobs(db, contextFor(db, other.users.owner));
    expect(theirs.rows.map((r) => r.id)).toEqual([foreign.id]);
    expect(() => getJobRowByNumber(db, ctxOf("owner"), "PJ-0001")).not.toThrow();
    expect(getJobRowByNumber(db, contextFor(db, other.users.owner), "pj-0001").id).toBe(foreign.id);
  });
});

describe("listJobs filters", () => {
  it("quick filters: overdue, due_today, due_this_week, unassigned, awaiting_review, revision_required, completed, cancelled, paused, my_jobs", () => {
    const overdue = job({ statusKey: "in_progress", dueDate: due("2026-10-07") });
    const today = job({ statusKey: "accepted", dueDate: due("2026-10-08") });
    const saturday = job({ statusKey: "in_progress", dueDate: due("2026-10-10") });
    const nextWeek = job({ statusKey: "in_progress", dueDate: due("2026-10-14") });
    const approvedLate = job({ statusKey: "approved", dueDate: due("2026-10-01") });
    const unassigned = job({ statusKey: "ready" });
    const review = job({ statusKey: "submitted" });
    const revision = job({ statusKey: "revision" });
    const completed = job({ statusKey: "completed" });
    const cancelled = job({ statusKey: "cancelled" });
    const paused = job({ statusKey: "in_progress", isPaused: true });
    const mine = job({ statusKey: "in_progress", editorId: ids.users.editor2, photographerId: ids.users.photographer2, createdByUserId: ids.users.photographer2 });
    const owner = ctxOf("owner");
    const q = (quick: string) => numbers(listJobs(db, owner, { quick }).rows);

    expect(q("overdue")).toEqual([overdue.jobNumber]);
    expect(q("due_today")).toEqual([today.jobNumber]);
    // Week = Mon 5 Oct – Sun 11 Oct (week_starts_on = 1)
    expect(q("due_this_week")).toEqual(numbers([overdue, today, saturday]));
    expect(q("unassigned")).toEqual([unassigned.jobNumber]);
    expect(q("awaiting_review")).toEqual([review.jobNumber]);
    expect(q("revision_required")).toEqual([revision.jobNumber]);
    expect(q("completed")).toEqual([completed.jobNumber]);
    expect(q("cancelled")).toEqual([cancelled.jobNumber]);
    expect(q("paused")).toEqual([paused.jobNumber]);
    expect(numbers(listJobs(db, ctxOf("editor2"), { quick: "my_jobs" }).rows)).toEqual([mine.jobNumber]);
    expect(nextWeek.jobNumber).toBeTruthy();
    expect(approvedLate.jobNumber).toBeTruthy();

    const flags = listJobs(db, owner, { quick: "overdue" }).rows[0];
    expect(flags.isOverdue).toBe(true);
    expect(flags.daysRemaining).toBe(-1);
    const todayRow = listJobs(db, owner, { quick: "due_today" }).rows[0];
    expect(todayRow.isDueToday).toBe(true);
    expect(todayRow.daysRemaining).toBe(0);
    // A done job past its due date is never overdue.
    const approvedRow = listJobs(db, owner, { statusCategory: "approved" }).rows[0];
    expect(approvedRow.isOverdue).toBe(false);
  });

  it("hides cancelled jobs unless asked for", () => {
    const live = job({ statusKey: "in_progress" });
    const cancelled = job({ statusKey: "cancelled" });
    const owner = ctxOf("owner");
    expect(numbers(listJobs(db, owner).rows)).toEqual([live.jobNumber]);
    expect(numbers(listJobs(db, owner, { includeCancelled: "1" }).rows)).toEqual(numbers([live, cancelled]));
    expect(numbers(listJobs(db, owner, { statusCategory: ["cancelled"] }).rows)).toEqual([cancelled.jobNumber]);
  });

  it("filters by category, status, people (incl. none), client, project, job type, priority, paused", () => {
    const otherClient = db.insert(clients).values({ organisationId: ids.organisationId, name: "Coastal Homes" }).returning().get();
    const otherProject = db.insert(projects).values({ organisationId: ids.organisationId, clientId: otherClient.id, name: "9 Beach Rd" }).returning().get();
    const a = job({ statusKey: "in_progress", editorId: ids.users.editor1, priority: "urgent", jobTypeId: ids.jobTypes.Wedding });
    const b = job({ statusKey: "submitted", editorId: ids.users.editor2, projectId: otherProject.id, photographerId: ids.users.photographer2 });
    const c = job({ statusKey: "new", editorId: null, photographerId: null, priority: "low" });
    const owner = ctxOf("owner");
    const f = (input: Record<string, unknown>) => numbers(listJobs(db, owner, input).rows);

    expect(f({ statusCategory: "in_progress,submitted" })).toEqual(numbers([a, b]));
    expect(f({ statusId: [ids.statuses.new] })).toEqual([c.jobNumber]);
    expect(f({ editorId: ids.users.editor2 })).toEqual([b.jobNumber]);
    expect(f({ editorId: "none" })).toEqual([c.jobNumber]);
    expect(f({ editorId: [ids.users.editor1, "none"] })).toEqual(numbers([a, c]));
    expect(f({ photographerId: ids.users.photographer2 })).toEqual([b.jobNumber]);
    expect(f({ photographerId: "none" })).toEqual([c.jobNumber]);
    expect(f({ clientId: otherClient.id })).toEqual([b.jobNumber]);
    expect(f({ projectId: ids.projectId })).toEqual(numbers([a, c]));
    expect(f({ jobTypeId: ids.jobTypes.Wedding })).toEqual([a.jobNumber]);
    expect(f({ priority: ["urgent", "low"] })).toEqual(numbers([a, c]));
    expect(f({ isPaused: "true" })).toEqual([]);
  });

  it("free text q matches name, job number, client and project", () => {
    const otherClient = db.insert(clients).values({ organisationId: ids.organisationId, name: "Coastal Homes" }).returning().get();
    const otherProject = db.insert(projects).values({ organisationId: ids.organisationId, clientId: otherClient.id, name: "9 Beach Rd" }).returning().get();
    const a = job({ name: "Twilight shoot" });
    const b = job({ name: "Kitchen", projectId: otherProject.id });
    const owner = ctxOf("owner");
    const f = (q: string) => numbers(listJobs(db, owner, { q }).rows);
    expect(f("twilight")).toEqual([a.jobNumber]);
    expect(f(b.jobNumber.toLowerCase())).toEqual([b.jobNumber]);
    expect(f("coastal")).toEqual([b.jobNumber]);
    expect(f("beach")).toEqual([b.jobNumber]);
    expect(f("smith street")).toEqual([a.jobNumber]);
    expect(f("100%")).toEqual([]);
  });

  it("dueFrom / dueTo use civil days in the org timezone", () => {
    const d7 = job({ dueDate: due("2026-10-07") });
    const d8 = job({ dueDate: due("2026-10-08") });
    const d9 = job({ dueDate: due("2026-10-09") });
    job({ dueDate: null });
    const owner = ctxOf("owner");
    expect(numbers(listJobs(db, owner, { dueFrom: "2026-10-08", dueTo: "2026-10-08" }).rows)).toEqual([d8.jobNumber]);
    expect(numbers(listJobs(db, owner, { dueFrom: "2026-10-08" }).rows)).toEqual(numbers([d8, d9]));
    expect(numbers(listJobs(db, owner, { dueTo: "2026-10-08" }).rows)).toEqual(numbers([d7, d8]));
  });
});

describe("listJobs sorting, grouping, pagination", () => {
  it("sorts by any table column in either direction (nulls last)", () => {
    const low = job({ priority: "low", dueDate: due("2026-10-20"), editorId: ids.users.editor2, statusKey: "in_progress" });
    const urgent = job({ priority: "urgent", dueDate: null, editorId: ids.users.editor1, statusKey: "in_progress" });
    const high = job({ priority: "high", dueDate: due("2026-10-09"), editorId: null, statusKey: "ready" });
    const owner = ctxOf("owner");
    const order = (sort: unknown) => listJobs(db, owner, { sort }).rows.map((r) => r.jobNumber);

    expect(order("-priority")).toEqual([urgent.jobNumber, high.jobNumber, low.jobNumber]);
    expect(order("priority:asc")).toEqual([low.jobNumber, high.jobNumber, urgent.jobNumber]);
    expect(order("dueDate")).toEqual([high.jobNumber, low.jobNumber, urgent.jobNumber]);
    expect(order("-dueDate")).toEqual([low.jobNumber, high.jobNumber, urgent.jobNumber]);
    expect(order("daysRemaining")).toEqual([high.jobNumber, low.jobNumber, urgent.jobNumber]);
    expect(order("editor")).toEqual([low.jobNumber, urgent.jobNumber, high.jobNumber]); // Ed, Eve, (none)
    expect(order("-job")).toEqual([high.jobNumber, urgent.jobNumber, low.jobNumber]);
    expect(order([{ column: "status", dir: "asc" }])[0]).toBe(high.jobNumber); // ready before in_progress
    expect(order([{ column: "status", dir: "desc" }])[2]).toBe(high.jobNumber);
    for (const column of ["client", "project", "photographer", "created", "shootDate", "revisionCount", "lastActivity", "completionPercent", "link", "jobType", "reviewDueDate", "deliveryDueDate"]) {
      expect(order(column)).toHaveLength(3);
    }
    expect(() => listJobs(db, owner, { sort: "nope" })).toThrow(ValidationError);
  });

  it("cursor-paginates with a stable total and caps limit at 200", () => {
    const made = Array.from({ length: 5 }, (_, i) => job({ dueDate: due(`2026-10-1${i}`) }));
    const owner = ctxOf("owner");
    const p1 = listJobs(db, owner, { limit: 2, sort: "dueDate" });
    expect(p1.rows.map((r) => r.jobNumber)).toEqual([made[0].jobNumber, made[1].jobNumber]);
    expect(p1.total).toBe(5);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = listJobs(db, owner, { limit: "2", sort: "dueDate", cursor: p1.nextCursor });
    expect(p2.rows.map((r) => r.jobNumber)).toEqual([made[2].jobNumber, made[3].jobNumber]);
    const p3 = listJobs(db, owner, { limit: 2, sort: "dueDate", cursor: p2.nextCursor });
    expect(p3.rows.map((r) => r.jobNumber)).toEqual([made[4].jobNumber]);
    expect(p3.nextCursor).toBeNull();
    expect(() => listJobs(db, owner, { limit: 201 })).toThrow(ValidationError);
    expect(decodeOffsetCursor(encodeOffsetCursor(40))).toBe(40);
    expect(decodeOffsetCursor("garbage")).toBe(0);
  });

  it("groups over the full result with per-group counts", () => {
    job({ priority: "urgent" });
    job({ priority: "urgent" });
    job({ priority: "low" });
    const res = listJobs(db, ctxOf("owner"), { groupBy: "priority", limit: 1 });
    expect(res.groups).toEqual([
      { key: "urgent", label: "Urgent", count: 2 },
      { key: "low", label: "Low", count: 1 },
    ]);
    expect(res.rowGroupKeys).toEqual(["urgent"]);

    const byEditor = listJobs(db, ctxOf("owner"), { groupBy: "editor" });
    expect(byEditor.groups).toEqual([{ key: "none", label: "Unassigned", count: 3 }]);
  });

  it("groups by due bucket", () => {
    job({ statusKey: "in_progress", dueDate: due("2026-10-07") });
    job({ statusKey: "in_progress", dueDate: due("2026-10-08") });
    job({ statusKey: "in_progress", dueDate: due("2026-10-09") });
    job({ statusKey: "in_progress", dueDate: null });
    const res = listJobs(db, ctxOf("owner"), { groupBy: "dueDate" });
    expect(res.groups?.map((g) => [g.key, g.count])).toEqual([
      ["overdue", 1],
      ["today", 1],
      ["tomorrow", 1],
      ["none", 1],
    ]);
    expect(res.rowGroupKeys).toEqual(["overdue", "today", "tomorrow", "none"]);
  });

  it("merges a saved view under explicit filters; private views of others are 404", () => {
    const a = job({ priority: "urgent", statusKey: "in_progress" });
    const b = job({ priority: "urgent", statusKey: "submitted" });
    job({ priority: "low", statusKey: "in_progress" });
    const view = db
      .insert(savedViews)
      .values({
        organisationId: ids.organisationId,
        ownerUserId: ids.users.manager,
        name: "Urgent",
        scope: "all_work",
        config: { filters: { priority: ["urgent"] }, sort: [{ column: "job", dir: "desc" }], columns: ["job"] },
      })
      .returning()
      .get();
    const manager = ctxOf("manager");
    expect(listJobs(db, manager, { viewId: view.id }).rows.map((r) => r.jobNumber)).toEqual([b.jobNumber, a.jobNumber]);
    expect(listJobs(db, manager, { viewId: view.id, statusCategory: "in_progress" }).rows.map((r) => r.jobNumber)).toEqual([a.jobNumber]);
    expect(() => listJobs(db, ctxOf("owner"), { viewId: view.id })).toThrow(NotFoundError);
    db.update(savedViews).set({ isShared: true }).where(eq(savedViews.id, view.id)).run();
    expect(listJobs(db, ctxOf("owner"), { viewId: view.id }).rows).toHaveLength(2);
  });

  it("maps JobRow fields (people refs, time in status, primary link)", () => {
    const a = job({ statusKey: "in_progress", editorId: ids.users.editor1, estimatedHours: 3 });
    fakeClock.advanceHours(2);
    const row = listJobs(db, ctxOf("owner")).rows[0];
    expect(row).toMatchObject({
      id: a.id,
      client: { id: ids.clientId, name: "Harbour Realty" },
      project: { id: ids.projectId, name: "123 Smith Street" },
      editor: { id: ids.users.editor1, name: "Eve Editor", role: "editor", isActive: true },
      photographer: { id: ids.users.photographer1 },
      status: { id: ids.statuses.in_progress, category: "in_progress" },
      statusCategory: "in_progress",
      estimatedHours: 3,
      primaryLink: null,
      timeInStatusSeconds: 7200,
    });
  });
});
