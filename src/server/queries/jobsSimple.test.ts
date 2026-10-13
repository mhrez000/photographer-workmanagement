import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clients, jobLinks, jobs } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, setUserFlags, type JobFixtureOptions, type SeedIds, type TestDb } from "@/db/test-db";
import { endOfCivilDayIso } from "@/lib/dates";
import { STAGES, type Stage } from "@/lib/stages";
import { ForbiddenError, ValidationError } from "@/server/errors";
import { calendarJobs, listJobsByStage, stageCounts } from "./jobsSimple";

const TZ = "Australia/Sydney";
const NOW = "2026-10-08T00:00:00.000Z"; // Thu 8 Oct 2026, 11:00 AEDT
const due = (civil: string) => endOfCivilDayIso(civil, TZ);

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set(NOW);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

const job = async (opts: JobFixtureOptions = {}) => (await insertJobFixture(db, ids, opts)).job;
const ctxOf = async (key: keyof SeedIds["users"]) => await contextFor(db, ids.users[key]);
const numbers = (rows: { jobNumber: string }[]) => rows.map((r) => r.jobNumber).sort();

/** The 13 default-workflow statuses → the stage each must display as (plan §4). */
const STATUS_TO_STAGE: Record<string, Stage> = {
  new: "needs_editor",
  ready: "needs_editor",
  assigned: "with_editor",
  accepted: "with_editor",
  in_progress: "with_editor",
  submitted: "ready_to_check",
  review: "ready_to_check",
  resubmitted: "ready_to_check",
  revision: "changes_asked",
  approved: "done",
  delivered: "done",
  completed: "done",
  cancelled: "cancelled",
};

describe("stage bucketing (display layer over the 13 status categories)", () => {
  it("every status lands in exactly one stage tab; Done and Cancelled are never active", async () => {
    const byKey = new Map<string, string>();
    for (const key of Object.keys(STATUS_TO_STAGE)) byKey.set(key, (await job({ statusKey: key, name: `Job ${key}` })).jobNumber);
    const owner = await ctxOf("owner");
    for (const stage of STAGES) {
      const expected = Object.entries(STATUS_TO_STAGE)
        .filter(([, s]) => s === stage)
        .map(([k]) => byKey.get(k) as string)
        .sort();
      const res = await listJobsByStage(db, owner, { stage });
      expect(numbers(res.rows), stage).toEqual(expected);
      expect(res.total).toBe(expected.length);
      for (const row of res.rows) expect(row.stage.stage).toBe(stage);
    }
    const active = await listJobsByStage(db, owner, {});
    expect(active.total).toBe(9);
    expect(active.rows.every((r) => r.stage.active)).toBe(true);
    expect(active.rows.some((r) => r.statusCategory === "approved" || r.statusCategory === "cancelled")).toBe(false);
  });

  it("Show cancelled adds cancelled jobs to All active; the done tab lists most recently finished first", async () => {
    await job({ statusKey: "new" });
    const c = await job({ statusKey: "cancelled" });
    const owner = await ctxOf("owner");
    expect((await listJobsByStage(db, owner, { stage: "all_active" })).total).toBe(1);
    const shown = await listJobsByStage(db, owner, { showCancelled: "1" });
    expect(shown.total).toBe(2);
    expect(shown.rows.find((r) => r.id === c.id)?.stage.stage).toBe("cancelled");
    const older = await job({ statusKey: "approved", at: "2026-10-01T00:00:00.000Z" });
    const newer = await job({ statusKey: "completed", at: "2026-10-05T00:00:00.000Z" });
    expect((await listJobsByStage(db, owner, { stage: "done" })).rows.map((r) => r.id)).toEqual([newer.id, older.id]);
  });

  it("sub-labels and rounds follow the status: Not started / Editing / Round N / Not sent to client", async () => {
    const owner = await ctxOf("owner");
    const assigned = await job({ statusKey: "assigned" });
    const editing = await job({ statusKey: "in_progress" });
    const round2 = await job({ statusKey: "resubmitted" });
    await db.update(jobs).set({ revisionCount: 1 }).where(eq(jobs.id, round2.id));
    const approved = await job({ statusKey: "approved" });
    const rows = (await listJobsByStage(db, owner, { showCancelled: "1" })).rows;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(assigned.id)?.stage.subLabel).toBe("not_started");
    expect(byId.get(editing.id)?.stage.subLabel).toBe("editing");
    expect(byId.get(round2.id)).toMatchObject({ round: 2, stage: { subLabel: "round", round: 2 } });
    const done = (await listJobsByStage(db, owner, { stage: "done" })).rows[0];
    expect(done.id).toBe(approved.id);
    expect(done.stage.subLabel).toBe("not_sent_to_client");
    expect(done.waitingOn).toBeNull();
  });
});

describe("late = active stage ∧ due day before today (org tz)", () => {
  it("flags yesterday's due date, not today's, and never a Done job", async () => {
    const yesterday = await job({ statusKey: "in_progress", dueDate: due("2026-10-07"), name: "Yesterday" });
    const today = await job({ statusKey: "in_progress", dueDate: due("2026-10-08"), name: "Today" });
    const doneLate = await job({ statusKey: "approved", dueDate: due("2026-10-01"), name: "Done late" });
    const nextDayEncoding = await job({ statusKey: "assigned", dueDate: "2026-10-07T13:00:00.000Z", name: "Midnight encoding" }); // 8 Oct 00:00 AEDT = due 7 Oct
    const noDue = await job({ statusKey: "assigned", dueDate: null });
    const owner = await ctxOf("owner");
    const all = await listJobsByStage(db, owner, {});
    const byId = new Map(all.rows.map((r) => [r.id, r]));
    expect(byId.get(yesterday.id)?.due).toEqual({ dueDate: due("2026-10-07"), civilDate: "2026-10-07", daysFromToday: -1, late: true });
    expect(byId.get(today.id)?.due).toMatchObject({ civilDate: "2026-10-08", daysFromToday: 0, late: false });
    expect(byId.get(nextDayEncoding.id)?.due).toMatchObject({ civilDate: "2026-10-07", daysFromToday: -1, late: true });
    expect(byId.get(noDue.id)?.due).toEqual({ dueDate: null, civilDate: null, daysFromToday: null, late: false });
    const done = (await listJobsByStage(db, owner, { stage: "done" })).rows[0];
    expect(done.id).toBe(doneLate.id);
    expect(done.due.late).toBe(false);

    const late = await listJobsByStage(db, owner, { late: "true" });
    expect(numbers(late.rows)).toEqual(numbers([yesterday, nextDayEncoding]));
    expect((await listJobsByStage(db, owner, { late: "1", stage: "done" })).total).toBe(0);
  });

  it("judges 'today' on the studio clock: at 23:30 UTC it is already the next day in Sydney", async () => {
    fakeClock.set("2026-10-07T13:30:00.000Z"); // 8 Oct 00:30 AEDT
    const j = await job({ statusKey: "in_progress", dueDate: due("2026-10-07") });
    const rows = (await listJobsByStage(db, await ctxOf("owner"), { late: "1" })).rows;
    expect(rows.map((r) => r.id)).toEqual([j.id]);
  });
});

describe("row content", () => {
  it("waiting on names the editor or the photographer, and says You for the viewer", async () => {
    const needs = await job({ statusKey: "new", editorId: null });
    const withEditor = await job({ statusKey: "in_progress" });
    const owner = await ctxOf("owner");
    const rows = new Map((await listJobsByStage(db, owner, {})).rows.map((r) => [r.id, r]));
    expect(rows.get(needs.id)?.waitingOn).toBe("Pia Photographer");
    expect(rows.get(withEditor.id)?.waitingOn).toBe("Eve Editor");
    const asP1 = new Map((await listJobsByStage(db, await ctxOf("photographer1"), {})).rows.map((r) => [r.id, r]));
    expect(asP1.get(needs.id)?.waitingOn).toBe("You");
    const asE1 = (await listJobsByStage(db, await ctxOf("editor1"), {})).rows;
    expect(asE1.map((r) => r.waitingOn)).toEqual(["You"]);
  });

  it("carries rush, the address, the raw link and the LATEST current finished link", async () => {
    const j = await job({ statusKey: "submitted", priority: "urgent" });
    const link = (over: Partial<typeof jobLinks.$inferInsert>) =>
      db.insert(jobLinks).values({ organisationId: ids.organisationId, jobId: j.id, kind: "finished_files", url: "https://x.example/a", addedByUserId: ids.users.editor1, createdAt: "2026-10-06T00:00:00.000Z", ...over });
    await link({ kind: "raw_files", url: "https://x.example/raw", createdAt: "2026-10-01T00:00:00.000Z" });
    await link({ url: "https://x.example/old", supersededAt: "2026-10-07T00:00:00.000Z" });
    await link({ url: "https://x.example/new", createdAt: "2026-10-07T00:00:00.000Z" });
    await link({ kind: "gallery", url: "https://x.example/gallery", createdAt: "2026-10-07T01:00:00.000Z" });
    const row = (await listJobsByStage(db, await ctxOf("owner"), {})).rows[0];
    expect(row.rush).toBe(true);
    expect(row.project.address).toBe("123 Smith Street, Bondi NSW");
    expect(row.rawLink?.url).toBe("https://x.example/raw");
    expect(row.finishedLink?.url).toBe("https://x.example/gallery"); // any finished-work kind counts; latest wins
    expect(row.jobTypeName).toBeTruthy();
    expect(row.sentAt).toBe(NOW);
  });
});

describe("visibility per persona", () => {
  async function threeJobs() {
    const a = await job({ statusKey: "in_progress", photographerId: ids.users.photographer1, editorId: ids.users.editor1, name: "Alpha" });
    const b = await job({ statusKey: "in_progress", photographerId: ids.users.photographer2, editorId: ids.users.editor2, createdByUserId: ids.users.photographer2, name: "Bravo" });
    const c = await job({ statusKey: "new", photographerId: ids.users.photographer2, editorId: null, createdByUserId: ids.users.photographer2, name: "Charlie" });
    return { a, b, c };
  }

  it("owner everything; extra photographer their own shoots; editor the jobs given to them", async () => {
    const { a, b, c } = await threeJobs();
    expect(numbers((await listJobsByStage(db, await ctxOf("owner"), {})).rows)).toEqual(numbers([a, b, c]));
    expect(numbers((await listJobsByStage(db, await ctxOf("coAdmin"), {})).rows)).toEqual(numbers([a, b, c]));
    expect(numbers((await listJobsByStage(db, await ctxOf("photographer1"), {})).rows)).toEqual([a.jobNumber]);
    expect(numbers((await listJobsByStage(db, await ctxOf("photographer2"), {})).rows)).toEqual(numbers([b, c]));
    expect(numbers((await listJobsByStage(db, await ctxOf("editor1"), {})).rows)).toEqual([a.jobNumber]);
    expect(numbers((await listJobsByStage(db, await ctxOf("editor2"), {})).rows)).toEqual([b.jobNumber]);
    expect((await stageCounts(db, await ctxOf("editor1"), {})).allActive).toBe(1);
  });

  it("clients get 403 from every simplified read, even for jobs shared with them", async () => {
    await job({ statusKey: "delivered", sharedWithClient: true });
    const client = await ctxOf("client");
    await expect(listJobsByStage(db, client, {})).rejects.toThrow(ForbiddenError);
    await expect(stageCounts(db, client, {})).rejects.toThrow(ForbiddenError);
    await expect(calendarJobs(db, client, { from: "2026-10-01", to: "2026-10-31" })).rejects.toThrow(ForbiddenError);
  });

  it("never returns another organisation's rows", async () => {
    const { a, b, c } = await threeJobs();
    const other = await seedMinimalOrg(db, { slug: "other" });
    await insertJobFixture(db, other, { statusKey: "in_progress", name: "Alpha foreign" });
    expect(numbers((await listJobsByStage(db, await ctxOf("owner"), {})).rows)).toEqual(numbers([a, b, c]));
    expect((await listJobsByStage(db, await contextFor(db, other.users.owner), {})).total).toBe(1);
  });

  it("an editor without See other editors' jobs cannot probe another editor through the editor filter", async () => {
    const { a } = await threeJobs();
    const e1 = await ctxOf("editor1");
    expect((await listJobsByStage(db, e1, { editorId: ids.users.editor2 })).total).toBe(0);
    expect((await listJobsByStage(db, e1, { editorId: ids.users.editor1 })).rows.map((r) => r.id)).toEqual([a.id]);
    await setUserFlags(db, ids.users.editor1, { canViewTeamJobs: true });
    expect((await listJobsByStage(db, await ctxOf("editor1"), { editorId: ids.users.editor2 })).total).toBe(1);
  });
});

describe("filters, counts, paging", () => {
  it("search matches name, number, client and address; editor and client filters narrow", async () => {
    const a = await job({ statusKey: "in_progress", name: "Penrose St" });
    const b = await job({ statusKey: "new", editorId: null, projectId: ids.projectId2, name: "Beach house" });
    const owner = await ctxOf("owner");
    expect(numbers((await listJobsByStage(db, owner, { q: "penrose" })).rows)).toEqual([a.jobNumber]);
    expect(numbers((await listJobsByStage(db, owner, { q: "coogee" })).rows)).toEqual([b.jobNumber]);
    expect(numbers((await listJobsByStage(db, owner, { q: "Coastal Key" })).rows)).toEqual([b.jobNumber]);
    expect(numbers((await listJobsByStage(db, owner, { q: a.jobNumber })).rows)).toEqual([a.jobNumber]);
    expect(numbers((await listJobsByStage(db, owner, { editorId: "none" })).rows)).toEqual([b.jobNumber]);
    expect(numbers((await listJobsByStage(db, owner, { editorId: ids.users.editor1 })).rows)).toEqual([a.jobNumber]);
    expect(numbers((await listJobsByStage(db, owner, { clientId: ids.clientId2 })).rows)).toEqual([b.jobNumber]);
    await expect(listJobsByStage(db, owner, { stage: "bogus" })).rejects.toThrow(ValidationError);
  });

  it("stageCounts gives every tab, Late and Cancelled under the same filters", async () => {
    await job({ statusKey: "new", editorId: null });
    await job({ statusKey: "in_progress", dueDate: due("2026-10-06") });
    await job({ statusKey: "revision", dueDate: due("2026-10-07") });
    await job({ statusKey: "submitted" });
    await job({ statusKey: "approved", dueDate: due("2026-10-01") });
    await job({ statusKey: "cancelled" });
    await job({ statusKey: "assigned", name: "Searchable", dueDate: due("2026-10-01") });
    const owner = await ctxOf("owner");
    const counts = await stageCounts(db, owner, {});
    expect(counts).toEqual({
      allActive: 5,
      byStage: { needs_editor: 1, with_editor: 2, ready_to_check: 1, changes_asked: 1, done: 1, cancelled: 1 },
      late: 3,
      cancelled: 1,
    });
    expect(await stageCounts(db, owner, { q: "searchable" })).toMatchObject({ allActive: 1, late: 1, byStage: { with_editor: 1, done: 0 } });
    expect((await stageCounts(db, await ctxOf("editor2"), {})).allActive).toBe(0);
  });

  it("pages with opaque cursors and a stable total", async () => {
    for (let i = 0; i < 5; i += 1) await job({ statusKey: "in_progress", dueDate: due(`2026-10-1${i}`) });
    const owner = await ctxOf("owner");
    const p1 = await listJobsByStage(db, owner, { limit: "2" });
    expect(p1.rows).toHaveLength(2);
    expect(p1.total).toBe(5);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await listJobsByStage(db, owner, { limit: "2", cursor: p1.nextCursor as string });
    const p3 = await listJobsByStage(db, owner, { limit: "2", cursor: p2.nextCursor as string });
    const all = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id);
    expect(new Set(all).size).toBe(5);
    expect(p3.nextCursor).toBeNull();
    expect(p1.rows.map((r) => r.due.civilDate)).toEqual(["2026-10-10", "2026-10-11"]);
  });
});

describe("calendarJobs (List / Calendar switch)", () => {
  it("returns shoot and due dates inside the civil window, due dates only for active stages, never cancelled", async () => {
    const shoot = await job({ statusKey: "new", editorId: null, shootDate: due("2026-10-10"), dueDate: due("2026-10-12") });
    await job({ statusKey: "approved", dueDate: due("2026-10-11") }); // done: no due event
    await job({ statusKey: "cancelled", shootDate: due("2026-10-10") });
    await job({ statusKey: "in_progress", dueDate: due("2026-11-20") }); // outside
    const owner = await ctxOf("owner");
    const events = await calendarJobs(db, owner, { from: "2026-10-01", to: "2026-10-31" });
    expect(events.map((e) => [e.kind, e.civilDate, e.job.id])).toEqual([
      ["shoot", "2026-10-10", shoot.id],
      ["due", "2026-10-12", shoot.id],
    ]);
    expect(await calendarJobs(db, await ctxOf("editor1"), { from: "2026-10-01", to: "2026-10-31" })).toEqual([]);
    await expect(calendarJobs(db, owner, { from: "October" })).rejects.toThrow(ValidationError);
  });

  it("clients without the portal flag do not change what staff see; only staff can read", async () => {
    await db.update(clients).set({ portalEnabled: false }).where(eq(clients.id, ids.clientId));
    await job({ statusKey: "new", editorId: null, shootDate: due("2026-10-09") });
    expect(await calendarJobs(db, await ctxOf("photographer1"), { from: "2026-10-09", to: "2026-10-09" })).toHaveLength(1);
  });
});
