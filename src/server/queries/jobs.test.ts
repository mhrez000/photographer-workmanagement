import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clients, jobAssignments, organisationSettings, projects, savedViews } from "@/db/schema";
import {
  addTeamFixture,
  contextFor,
  fakeClock,
  insertJobFixture,
  makeTestDb,
  seedMinimalOrg,
  setUserFlags,
  type JobFixtureOptions,
  type SeedIds,
  type TestDb,
} from "@/db/test-db";
import { endOfCivilDayIso } from "@/lib/dates";
import { NotFoundError, ValidationError } from "@/server/errors";
import {
  decodeOffsetCursor,
  encodeOffsetCursor,
  getJobRowByNumber,
  JOB_LIST_API_KEYS,
  listJobs,
  listJobsApi,
  parseJobListApiQuery,
  parseJobListFilters,
} from "./jobs";

const TZ = "Australia/Sydney";
const NOW = "2026-10-08T00:00:00.000Z"; // Thu 8 Oct 2026, 11:00 Sydney
const due = (civil: string) => endOfCivilDayIso(civil, TZ);

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set(NOW);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(async () => fakeClock.reset());

const job = async (opts: JobFixtureOptions = {}) => (await insertJobFixture(db, ids, opts)).job;
const ctxOf = async (key: keyof SeedIds["users"]) => await contextFor(db, ids.users[key]);
const numbers = (rows: { jobNumber: string }[]) => rows.map((r) => r.jobNumber).sort();

async function setSettings(values: Partial<typeof organisationSettings.$inferInsert>) {
  await db.update(organisationSettings).set(values).where(eq(organisationSettings.organisationId, ids.organisationId));
}

/** A = P1/E1 in progress, B = P2/E2 in progress, C = P2 new (created by P2, no editor). */
async function threeJobs() {
  const a = await job({ statusKey: "in_progress", photographerId: ids.users.photographer1, editorId: ids.users.editor1, name: "Alpha" });
  const b = await job({
    statusKey: "in_progress",
    photographerId: ids.users.photographer2,
    editorId: ids.users.editor2,
    createdByUserId: ids.users.photographer2,
    name: "Bravo",
  });
  const c = await job({ statusKey: "new", photographerId: ids.users.photographer2, editorId: null, createdByUserId: ids.users.photographer2, name: "Charlie" });
  return { a, b, c };
}

describe("listJobs visibility", () => {
  it("scopes rows per role (own / assigned)", async () => {
    const { a, b, c } = await threeJobs();
    expect(numbers((await listJobs(db, await ctxOf("owner"))).rows)).toEqual(numbers([a, b, c]));
    expect(numbers((await listJobs(db, await ctxOf("coAdmin"))).rows)).toEqual(numbers([a, b, c]));
    expect(numbers((await listJobs(db, await ctxOf("lead"))).rows)).toEqual(numbers([a, b, c])); // ⚑ See all jobs
    expect(numbers((await listJobs(db, await ctxOf("photographer1"))).rows)).toEqual([a.jobNumber]);
    expect(numbers((await listJobs(db, await ctxOf("photographer2"))).rows)).toEqual(numbers([b, c]));
    expect(numbers((await listJobs(db, await ctxOf("editor1"))).rows)).toEqual([a.jobNumber]);
    expect(numbers((await listJobs(db, await ctxOf("editor2"))).rows)).toEqual([b.jobNumber]);
  });

  it("teams and the deprecated organisation switches never widen visibility (roles v2: per-person switches)", async () => {
    const { a } = await threeJobs();
    await addTeamFixture(db, ids, { name: "Crew", memberIds: [ids.users.photographer1, ids.users.photographer2] });
    await setSettings({ photographersSeeTeamJobs: true, photographersSeeAllJobs: true, editorsSeeTeamJobs: true });
    expect(numbers((await listJobs(db, await ctxOf("photographer1"))).rows)).toEqual([a.jobNumber]);
    await addTeamFixture(db, ids, { name: "Editors", memberIds: [ids.users.editor1, ids.users.editor2] });
    expect(numbers((await listJobs(db, await ctxOf("editor1"))).rows)).toEqual([a.jobNumber]);
  });

  it("a member's See all jobs switch shows the whole organisation", async () => {
    const { a, b, c } = await threeJobs();
    await setUserFlags(db, ids.users.photographer1, { canViewAllJobs: true });
    expect(numbers((await listJobs(db, await ctxOf("photographer1"))).rows)).toEqual(numbers([a, b, c]));
  });

  it("an editor's See other editors' jobs switch shows every job held by an editor (not unassigned ones)", async () => {
    const { a, b } = await threeJobs();
    expect(numbers((await listJobs(db, await ctxOf("editor1"))).rows)).toEqual([a.jobNumber]);
    await setUserFlags(db, ids.users.editor1, { canViewTeamJobs: true });
    expect(numbers((await listJobs(db, await ctxOf("editor1"))).rows)).toEqual(numbers([a, b]));
  });

  it("editors see jobs they created; members see jobs they shoot or created as a photographer", async () => {
    const created = await job({ statusKey: "new", photographerId: ids.users.owner, editorId: null, createdByUserId: ids.users.editor2, name: "By editor" });
    expect(numbers((await listJobs(db, await ctxOf("editor2"))).rows)).toEqual([created.jobNumber]);
    expect((await listJobs(db, await ctxOf("editor1"))).rows).toEqual([]);
    const forP2 = await job({ statusKey: "new", photographerId: ids.users.photographer2, createdByUserId: ids.users.owner, name: "Owner made" });
    expect(numbers((await listJobs(db, await ctxOf("photographer2"))).rows)).toEqual([forP2.jobNumber]);
    expect(numbers((await listJobs(db, await ctxOf("photographer2"), { quick: "my_jobs" })).rows)).toEqual([forP2.jobNumber]);
  });

  it("archived teams grant nothing", async () => {
    const { a } = await threeJobs();
    await addTeamFixture(db, ids, { name: "Old", memberIds: [ids.users.photographer1, ids.users.photographer2], archived: true });
    expect(numbers((await listJobs(db, await ctxOf("photographer1"))).rows)).toEqual([a.jobNumber]);
  });

  it("past editors keep read visibility through job_assignments history", async () => {
    const { a, b } = await threeJobs();
    await db.insert(jobAssignments).values({
      organisationId: ids.organisationId,
      jobId: a.id,
      role: "editor",
      userId: ids.users.editor2,
      assignedAt: "2026-10-01T00:00:00.000Z",
      unassignedAt: "2026-10-02T00:00:00.000Z",
      unassignReason: "reassigned",
    });
    expect(numbers((await listJobs(db, await ctxOf("editor2"))).rows)).toEqual(numbers([a, b]));
  });

  it("clients (portal users) get no rows from any staff list, even for jobs shared with them", async () => {
    await threeJobs();
    await job({ statusKey: "delivered", sharedWithClient: true, name: "Shared" });
    const client = await ctxOf("client");
    const res = await listJobs(db, client, { includeCancelled: "1" });
    expect(res.rows).toEqual([]);
    expect(res.total).toBe(0);
    await expect(getJobRowByNumber(db, client, "PJ-0004")).rejects.toThrow(NotFoundError);
    expect((await listJobs(db, client, { groupBy: "status" })).groups).toEqual([]);
  });

  it("never returns another organisation's rows", async () => {
    const { a, b, c } = await threeJobs();
    const other = await seedMinimalOrg(db, { slug: "other" });
    const foreign = (await insertJobFixture(db, other, { statusKey: "in_progress", name: "Alpha foreign" })).job;
    const mine = await listJobs(db, await ctxOf("owner"));
    expect(numbers(mine.rows)).toEqual(numbers([a, b, c]));
    expect(mine.total).toBe(3);
    expect((await listJobs(db, await ctxOf("owner"), { q: "foreign" })).rows).toHaveLength(0);
    expect((await listJobs(db, await ctxOf("owner"), { clientId: other.clientId })).rows).toHaveLength(0);
    const theirs = await listJobs(db, await contextFor(db, other.users.owner));
    expect(theirs.rows.map((r) => r.id)).toEqual([foreign.id]);
    await expect(getJobRowByNumber(db, await ctxOf("owner"), "PJ-0001")).resolves.not.toThrow();
    expect((await getJobRowByNumber(db, await contextFor(db, other.users.owner), "pj-0001")).id).toBe(foreign.id);
  });
});

describe("listJobs filters", () => {
  it("quick filters: overdue, due_today, due_this_week, unassigned, awaiting_review, revision_required, completed, cancelled, paused, my_jobs", async () => {
    const overdue = await job({ statusKey: "in_progress", dueDate: due("2026-10-07") });
    const today = await job({ statusKey: "accepted", dueDate: due("2026-10-08") });
    const saturday = await job({ statusKey: "in_progress", dueDate: due("2026-10-10") });
    const nextWeek = await job({ statusKey: "in_progress", dueDate: due("2026-10-14") });
    const approvedLate = await job({ statusKey: "approved", dueDate: due("2026-10-01") });
    const unassigned = await job({ statusKey: "ready" });
    const review = await job({ statusKey: "submitted" });
    const revision = await job({ statusKey: "revision" });
    const completed = await job({ statusKey: "completed" });
    const cancelled = await job({ statusKey: "cancelled" });
    const paused = await job({ statusKey: "in_progress", isPaused: true });
    const mine = await job({
      statusKey: "in_progress",
      editorId: ids.users.editor2,
      photographerId: ids.users.photographer2,
      createdByUserId: ids.users.photographer2,
    });
    const owner = await ctxOf("owner");
    const q = async (quick: string) => numbers((await listJobs(db, owner, { quick })).rows);

    expect(await q("overdue")).toEqual([overdue.jobNumber]);
    expect(await q("due_today")).toEqual([today.jobNumber]);
    // Week = Mon 5 Oct – Sun 11 Oct (week_starts_on = 1)
    expect(await q("due_this_week")).toEqual(numbers([overdue, today, saturday]));
    expect(await q("unassigned")).toEqual([unassigned.jobNumber]);
    expect(await q("awaiting_review")).toEqual([review.jobNumber]);
    expect(await q("revision_required")).toEqual([revision.jobNumber]);
    expect(await q("completed")).toEqual([completed.jobNumber]);
    expect(await q("cancelled")).toEqual([cancelled.jobNumber]);
    expect(await q("paused")).toEqual([paused.jobNumber]);
    expect(numbers((await listJobs(db, await ctxOf("editor2"), { quick: "my_jobs" })).rows)).toEqual([mine.jobNumber]);
    expect(nextWeek.jobNumber).toBeTruthy();
    expect(approvedLate.jobNumber).toBeTruthy();

    const flags = (await listJobs(db, owner, { quick: "overdue" })).rows[0];
    expect(flags.isOverdue).toBe(true);
    expect(flags.daysRemaining).toBe(-1);
    const todayRow = (await listJobs(db, owner, { quick: "due_today" })).rows[0];
    expect(todayRow.isDueToday).toBe(true);
    expect(todayRow.daysRemaining).toBe(0);
    // A done job past its due date is never overdue.
    const approvedRow = (await listJobs(db, owner, { statusCategory: "approved" })).rows[0];
    expect(approvedRow.isOverdue).toBe(false);
  });

  it("hides cancelled jobs unless asked for", async () => {
    const live = await job({ statusKey: "in_progress" });
    const cancelled = await job({ statusKey: "cancelled" });
    const owner = await ctxOf("owner");
    expect(numbers((await listJobs(db, owner)).rows)).toEqual([live.jobNumber]);
    expect(numbers((await listJobs(db, owner, { includeCancelled: "1" })).rows)).toEqual(numbers([live, cancelled]));
    expect(numbers((await listJobs(db, owner, { statusCategory: ["cancelled"] })).rows)).toEqual([cancelled.jobNumber]);
  });

  it("filters by category, status, people (incl. none), client, project, job type, priority, paused", async () => {
    const otherClient = (await db.insert(clients).values({ organisationId: ids.organisationId, name: "Coastal Homes" }).returning())[0];
    const otherProject = (
      await db.insert(projects).values({ organisationId: ids.organisationId, clientId: otherClient.id, name: "9 Beach Rd" }).returning()
    )[0];
    const a = await job({ statusKey: "in_progress", editorId: ids.users.editor1, priority: "urgent", jobTypeId: ids.jobTypes.Wedding });
    const b = await job({ statusKey: "submitted", editorId: ids.users.editor2, projectId: otherProject.id, photographerId: ids.users.photographer2 });
    const c = await job({ statusKey: "new", editorId: null, photographerId: null, priority: "low" });
    const owner = await ctxOf("owner");
    const f = async (input: Record<string, unknown>) => numbers((await listJobs(db, owner, input)).rows);

    expect(await f({ statusCategory: "in_progress,submitted" })).toEqual(numbers([a, b]));
    expect(await f({ statusId: [ids.statuses.new] })).toEqual([c.jobNumber]);
    expect(await f({ editorId: ids.users.editor2 })).toEqual([b.jobNumber]);
    expect(await f({ editorId: "none" })).toEqual([c.jobNumber]);
    expect(await f({ editorId: [ids.users.editor1, "none"] })).toEqual(numbers([a, c]));
    expect(await f({ photographerId: ids.users.photographer2 })).toEqual([b.jobNumber]);
    expect(await f({ photographerId: "none" })).toEqual([c.jobNumber]);
    expect(await f({ clientId: otherClient.id })).toEqual([b.jobNumber]);
    expect(await f({ projectId: ids.projectId })).toEqual(numbers([a, c]));
    expect(await f({ jobTypeId: ids.jobTypes.Wedding })).toEqual([a.jobNumber]);
    expect(await f({ priority: ["urgent", "low"] })).toEqual(numbers([a, c]));
    expect(await f({ isPaused: "true" })).toEqual([]);
  });

  it("free text q matches name, job number, client and project", async () => {
    const otherClient = (await db.insert(clients).values({ organisationId: ids.organisationId, name: "Coastal Homes" }).returning())[0];
    const otherProject = (
      await db.insert(projects).values({ organisationId: ids.organisationId, clientId: otherClient.id, name: "9 Beach Rd" }).returning()
    )[0];
    const a = await job({ name: "Twilight shoot" });
    const b = await job({ name: "Kitchen", projectId: otherProject.id });
    const owner = await ctxOf("owner");
    const f = async (q: string) => numbers((await listJobs(db, owner, { q })).rows);
    expect(await f("twilight")).toEqual([a.jobNumber]);
    expect(await f(b.jobNumber.toLowerCase())).toEqual([b.jobNumber]);
    expect(await f("coastal")).toEqual([b.jobNumber]);
    expect(await f("beach")).toEqual([b.jobNumber]);
    expect(await f("smith street")).toEqual([a.jobNumber]);
    expect(await f("100%")).toEqual([]);
  });

  it("dueFrom / dueTo use civil days in the org timezone", async () => {
    const d7 = await job({ dueDate: due("2026-10-07") });
    const d8 = await job({ dueDate: due("2026-10-08") });
    const d9 = await job({ dueDate: due("2026-10-09") });
    await job({ dueDate: null });
    const owner = await ctxOf("owner");
    expect(numbers((await listJobs(db, owner, { dueFrom: "2026-10-08", dueTo: "2026-10-08" })).rows)).toEqual([d8.jobNumber]);
    expect(numbers((await listJobs(db, owner, { dueFrom: "2026-10-08" })).rows)).toEqual(numbers([d8, d9]));
    expect(numbers((await listJobs(db, owner, { dueTo: "2026-10-08" })).rows)).toEqual(numbers([d7, d8]));
  });
});

describe("listJobs sorting, grouping, pagination", () => {
  it("sorts by any table column in either direction (nulls last)", async () => {
    const low = await job({ priority: "low", dueDate: due("2026-10-20"), editorId: ids.users.editor2, statusKey: "in_progress" });
    const urgent = await job({ priority: "urgent", dueDate: null, editorId: ids.users.editor1, statusKey: "in_progress" });
    const high = await job({ priority: "high", dueDate: due("2026-10-09"), editorId: null, statusKey: "ready" });
    const owner = await ctxOf("owner");
    const order = async (sort: unknown) => (await listJobs(db, owner, { sort })).rows.map((r) => r.jobNumber);

    expect(await order("-priority")).toEqual([urgent.jobNumber, high.jobNumber, low.jobNumber]);
    expect(await order("priority:asc")).toEqual([low.jobNumber, high.jobNumber, urgent.jobNumber]);
    expect(await order("dueDate")).toEqual([high.jobNumber, low.jobNumber, urgent.jobNumber]);
    expect(await order("-dueDate")).toEqual([low.jobNumber, high.jobNumber, urgent.jobNumber]);
    expect(await order("daysRemaining")).toEqual([high.jobNumber, low.jobNumber, urgent.jobNumber]);
    expect(await order("editor")).toEqual([low.jobNumber, urgent.jobNumber, high.jobNumber]); // Ed, Eve, (none)
    expect(await order("-job")).toEqual([high.jobNumber, urgent.jobNumber, low.jobNumber]);
    expect((await order([{ column: "status", dir: "asc" }]))[0]).toBe(high.jobNumber); // ready before in_progress
    expect((await order([{ column: "status", dir: "desc" }]))[2]).toBe(high.jobNumber);
    for (const column of [
      "client",
      "project",
      "photographer",
      "created",
      "shootDate",
      "revisionCount",
      "lastActivity",
      "completionPercent",
      "link",
      "jobType",
      "reviewDueDate",
      "deliveryDueDate",
    ]) {
      expect(await order(column)).toHaveLength(3);
    }
    await expect(listJobs(db, owner, { sort: "nope" })).rejects.toThrow(ValidationError);
  });

  it("cursor-paginates with a stable total and caps limit at 200", async () => {
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await job({ dueDate: due(`2026-10-1${i}`) }));
    const owner = await ctxOf("owner");
    const p1 = await listJobs(db, owner, { limit: 2, sort: "dueDate" });
    expect(p1.rows.map((r) => r.jobNumber)).toEqual([made[0].jobNumber, made[1].jobNumber]);
    expect(p1.total).toBe(5);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await listJobs(db, owner, { limit: "2", sort: "dueDate", cursor: p1.nextCursor });
    expect(p2.rows.map((r) => r.jobNumber)).toEqual([made[2].jobNumber, made[3].jobNumber]);
    const p3 = await listJobs(db, owner, { limit: 2, sort: "dueDate", cursor: p2.nextCursor });
    expect(p3.rows.map((r) => r.jobNumber)).toEqual([made[4].jobNumber]);
    expect(p3.nextCursor).toBeNull();
    await expect(listJobs(db, owner, { limit: 201 })).rejects.toThrow(ValidationError);
    expect(decodeOffsetCursor(encodeOffsetCursor(40))).toBe(40);
    expect(decodeOffsetCursor("garbage")).toBe(0);
  });

  it("groups over the full result with per-group counts", async () => {
    await job({ priority: "urgent" });
    await job({ priority: "urgent" });
    await job({ priority: "low" });
    const res = await listJobs(db, await ctxOf("owner"), { groupBy: "priority", limit: 1 });
    expect(res.groups).toEqual([
      { key: "urgent", label: "Urgent", count: 2 },
      { key: "low", label: "Low", count: 1 },
    ]);
    expect(res.rowGroupKeys).toEqual(["urgent"]);

    const byEditor = await listJobs(db, await ctxOf("owner"), { groupBy: "editor" });
    expect(byEditor.groups).toEqual([{ key: "none", label: "Unassigned", count: 3 }]);
  });

  it("groups by due bucket", async () => {
    await job({ statusKey: "in_progress", dueDate: due("2026-10-07") });
    await job({ statusKey: "in_progress", dueDate: due("2026-10-08") });
    await job({ statusKey: "in_progress", dueDate: due("2026-10-09") });
    await job({ statusKey: "in_progress", dueDate: null });
    const res = await listJobs(db, await ctxOf("owner"), { groupBy: "dueDate" });
    expect(res.groups?.map((g) => [g.key, g.count])).toEqual([
      ["overdue", 1],
      ["today", 1],
      ["tomorrow", 1],
      ["none", 1],
    ]);
    expect(res.rowGroupKeys).toEqual(["overdue", "today", "tomorrow", "none"]);
  });

  it("merges a saved view under explicit filters; private views of others are 404", async () => {
    const a = await job({ priority: "urgent", statusKey: "in_progress" });
    const b = await job({ priority: "urgent", statusKey: "submitted" });
    await job({ priority: "low", statusKey: "in_progress" });
    const view = (
      await db
        .insert(savedViews)
        .values({
          organisationId: ids.organisationId,
          ownerUserId: ids.users.coAdmin,
          name: "Urgent",
          scope: "all_work",
          config: { filters: { priority: ["urgent"] }, sort: [{ column: "job", dir: "desc" }], columns: ["job"] },
        })
        .returning()
    )[0];
    const coAdmin = await ctxOf("coAdmin");
    expect((await listJobs(db, coAdmin, { viewId: view.id })).rows.map((r) => r.jobNumber)).toEqual([b.jobNumber, a.jobNumber]);
    expect((await listJobs(db, coAdmin, { viewId: view.id, statusCategory: "in_progress" })).rows.map((r) => r.jobNumber)).toEqual([a.jobNumber]);
    await expect(listJobs(db, await ctxOf("owner"), { viewId: view.id })).rejects.toThrow(NotFoundError);
    await db.update(savedViews).set({ isShared: true }).where(eq(savedViews.id, view.id));
    expect((await listJobs(db, await ctxOf("owner"), { viewId: view.id })).rows).toHaveLength(2);
  });

  it("maps JobRow fields (people refs, time in status, primary link)", async () => {
    const a = await job({ statusKey: "in_progress", editorId: ids.users.editor1, estimatedHours: 3 });
    fakeClock.advanceHours(2);
    const row = (await listJobs(db, await ctxOf("owner"))).rows[0];
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

describe("query aliases and the strict REST schema", () => {
  it("filter=mine is an alias for quick=my_jobs (API and page parsing)", async () => {
    const ctx = await ctxOf("editor1");
    expect((await parseJobListApiQuery(db, ctx, { filter: "mine" })).quick).toEqual(["my_jobs"]);
    expect((await parseJobListFilters(db, ctx, { filter: "mine" })).quick).toEqual(["my_jobs"]);
    expect((await parseJobListApiQuery(db, ctx, { filter: "mine", quick: "overdue" })).quick).toEqual(["overdue", "my_jobs"]);
    const mine = await job({ statusKey: "in_progress", editorId: ids.users.editor1 });
    await job({ statusKey: "in_progress", editorId: ids.users.editor2 });
    const owner = await ctxOf("owner");
    expect((await listJobsApi(db, owner, { filter: "mine" })).rows.map((r) => r.id)).not.toContain(mine.id);
    expect((await listJobsApi(db, ctx, { filter: "mine" })).rows.map((r) => r.id)).toEqual([mine.id]);
  });

  it("an unknown key or alias value is a 400 on the API, but ignored by page parsing", async () => {
    const ctx = await ctxOf("owner");
    await expect(parseJobListApiQuery(db, ctx, { bogus: "1" })).rejects.toThrow(ValidationError);
    await expect(listJobsApi(db, ctx, { bogus: "1" })).rejects.toThrow(ValidationError);
    await expect(parseJobListApiQuery(db, ctx, { filter: "everything" })).rejects.toThrow(ValidationError);
    await expect(parseJobListFilters(db, ctx, { bogus: "1" })).resolves.not.toThrow();
    await expect(listJobs(db, ctx, { bogus: "1" })).resolves.not.toThrow();
  });

  it("accepts every key the work table forwards (filters, cursor, limit, viewId, sort, UI-only keys)", async () => {
    const ctx = await ctxOf("owner");
    for (const k of [
      "q",
      "quick",
      "statusCategory",
      "editorId",
      "sort",
      "groupBy",
      "viewId",
      "cursor",
      "limit",
      "tab",
      "columns",
      "dir",
      "completedFrom",
      "revisedFrom",
      "statusEnteredBefore",
    ]) {
      expect(JOB_LIST_API_KEYS).toContain(k);
    }
    await expect(
      listJobsApi(db, ctx, {
        q: "x",
        quick: "overdue",
        sort: "dueDate:asc",
        groupBy: "status",
        cursor: encodeOffsetCursor(0),
        limit: "10",
        tab: "all",
        columns: "job,status",
        dir: "asc",
      }),
    ).resolves.not.toThrow();
  });

  it("drill-down bounds reject malformed instants", async () => {
    const ctx = await ctxOf("owner");
    await expect(listJobsApi(db, ctx, { completedFrom: "2026-10-01Tnope" })).rejects.toThrow(ValidationError);
    await expect(listJobsApi(db, ctx, { statusEnteredBefore: "yesterday" })).rejects.toThrow(ValidationError);
    await expect(listJobsApi(db, ctx, { revisedFrom: "2026-10-01T00:00:00.000Z", revisedTo: "2026-10-08" })).resolves.not.toThrow();
  });
});

describe("listJobs — personal / business view (docs/ROLES.md §8)", () => {
  it("scope mine = jobs where I am the photographer; the param beats the cookie; non-holders ignore both", async () => {
    const own = await job({ statusKey: "in_progress", photographerId: ids.users.owner, createdByUserId: ids.users.owner, name: "Own shoot" });
    // The owner created this for photographer2: the owner manages nothing about it as a shooter → not in My shoots.
    const forP2 = await job({ statusKey: "in_progress", photographerId: ids.users.photographer2, createdByUserId: ids.users.owner, name: "For P2" });
    const owner = await ctxOf("owner");
    const business = await listJobs(db, owner);
    expect(business.scope).toBe("business");
    expect(numbers(business.rows)).toEqual(numbers([own, forP2]));
    const mine = await listJobs(db, owner, { scope: "mine" });
    expect(mine.scope).toBe("mine");
    expect(numbers(mine.rows)).toEqual([own.jobNumber]);
    expect(mine.total).toBe(1);
    expect(numbers((await listJobs(db, owner, {}, { scopeCookie: "mine" })).rows)).toEqual([own.jobNumber]);
    expect(numbers((await listJobs(db, owner, { scope: "business" }, { scopeCookie: "mine" })).rows)).toEqual(numbers([own, forP2]));
    expect(numbers((await listJobs(db, owner, { scope: "all" })).rows)).toEqual(numbers([own, forP2])); // "all" = business
    expect((await listJobsApi(db, owner, { scope: "mine" })).rows.map((r) => r.id)).toEqual([own.id]);
    // grouping counts follow the scope too
    expect((await listJobs(db, owner, { scope: "mine", groupBy: "photographer" })).groups?.map((g) => g.count)).toEqual([1]);

    // The lead (⚑all) has the switch; photographer2 / editors do not: ?scope is ignored, never an error or a widening.
    expect(numbers((await listJobs(db, await ctxOf("lead"), { scope: "mine" })).rows)).toEqual([]);
    const p2 = await ctxOf("photographer2");
    expect((await listJobs(db, p2, { scope: "mine" })).scope).toBeNull();
    expect(numbers((await listJobs(db, p2, { scope: "business" })).rows)).toEqual([forP2.jobNumber]);
    expect(numbers((await listJobs(db, await ctxOf("editor1"), { scope: "business" })).rows)).toEqual(numbers((await listJobs(db, await ctxOf("editor1"))).rows));
  });

  it("editors without the team switch never learn who holds a past job (rows, groups, filters)", async () => {
    const a = await job({ statusKey: "in_progress", editorId: ids.users.editor1 });
    await db.insert(jobAssignments).values({
      organisationId: ids.organisationId,
      jobId: a.id,
      role: "editor",
      userId: ids.users.editor2,
      assignedAt: "2026-10-01T00:00:00.000Z",
      unassignedAt: "2026-10-02T00:00:00.000Z",
      unassignReason: "reassigned",
    });
    const e2 = await ctxOf("editor2");
    const res = await listJobs(db, e2, { groupBy: "editor" });
    expect(res.rows.map((r) => r.editor?.name)).toEqual(["Another editor"]);
    expect(res.groups?.map((g) => g.label)).toEqual(["Another editor"]);
    expect(res.rowGroupKeys).toEqual(["another-editor"]);
    expect((await listJobs(db, e2, { editorId: ids.users.editor1 })).rows).toEqual([]);
    expect((await listJobs(db, e2, { editorId: "another-editor" })).rows.map((r) => r.id)).toEqual([a.id]);
  });
});
