import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type JobFixtureOptions, type SeedIds, type TestDb } from "@/db/test-db";
import { endOfCivilDayIso } from "@/lib/dates";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { editorPickerOptions, editorsCsv, getEditorDetail, getEditorsOverview } from "./editors";
import { addRevision, moveJob } from "./test-history";

const TZ = "Australia/Sydney";
const NOW = "2026-10-08T00:00:00.000Z"; // Thu 8 Oct 2026, 11:00 AEDT
const due = (civil: string) => endOfCivilDayIso(civil, TZ);
const at = (civil: string, hour = 0) => `${civil}T${String(hour).padStart(2, "0")}:00:00.000Z`;

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set(NOW);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db, { at: "2026-06-01T00:00:00.000Z" });
});
afterEach(() => fakeClock.reset());

const job = async (opts: JobFixtureOptions = {}) => (await insertJobFixture(db, ids, opts)).job;
const ctxOf = async (key: keyof SeedIds["users"]) => await contextFor(db, ids.users[key]);

/** A job with real history: assigned → editing → sent for checking (at `sent`) → approved (at `approved`), optionally one round of changes. */
async function finishedJob(opts: { dueCivil: string; sent: string; approved: string; created?: string; editorId?: string; rounds?: number; shootCivil?: string }) {
  const created = opts.created ?? at("2026-10-01");
  const j = await job({ statusKey: "assigned", at: created, dueDate: due(opts.dueCivil), editorId: opts.editorId ?? ids.users.editor1, shootDate: opts.shootCivil ? due(opts.shootCivil) : null });
  await moveJob(db, ids, j.id, "in_progress", at(created.slice(0, 10), 2));
  await moveJob(db, ids, j.id, "submitted", opts.sent);
  if (opts.rounds) {
    await moveJob(db, ids, j.id, "revision", `${opts.sent.slice(0, 10)}T06:00:00.000Z`);
    await addRevision(db, ids, j.id, opts.rounds, `${opts.sent.slice(0, 10)}T06:00:00.000Z`);
    await moveJob(db, ids, j.id, "resubmitted", `${opts.sent.slice(0, 10)}T20:00:00.000Z`);
  }
  await moveJob(db, ids, j.id, "approved", opts.approved);
  return j;
}

async function seedEditors() {
  // Eve (editor1): 5 finished this month — 4 sent on time, 1 sent two days late with a round of changes.
  await finishedJob({ dueCivil: "2026-10-05", sent: at("2026-10-04", 3), approved: at("2026-10-06") });
  const lateOne = await finishedJob({ dueCivil: "2026-10-03", sent: at("2026-10-05", 1), approved: at("2026-10-07"), rounds: 1 }); // 5 Oct 12:00 AEDT, due 3 Oct → 2 days late
  await finishedJob({ dueCivil: "2026-10-05", sent: at("2026-10-05", 10), approved: at("2026-10-06", 1) }); // 5 Oct 21:00 AEDT = still 5 Oct
  await finishedJob({ dueCivil: "2026-10-06", sent: at("2026-10-05"), approved: at("2026-10-07", 1) });
  await finishedJob({ dueCivil: "2026-10-06", sent: at("2026-10-05"), approved: at("2026-10-07", 2) });
  // Eve: one finished LAST month (counts in last_month only) — the owner's slow check must not hurt her.
  await finishedJob({ dueCivil: "2026-09-10", sent: at("2026-09-09"), approved: at("2026-09-25"), created: at("2026-09-01") });
  // Eve's desk now: editing (late), not started (due tomorrow), changes asked (no due date).
  const lateDesk = await job({ statusKey: "in_progress", dueDate: due("2026-10-07") });
  await job({ statusKey: "assigned", dueDate: due("2026-10-09") });
  const changes = await job({ statusKey: "revision", dueDate: null });
  // Ed (editor2): two finished — not enough for percentages; nothing on his desk.
  await finishedJob({ dueCivil: "2026-10-05", sent: at("2026-10-07"), approved: at("2026-10-07", 3), editorId: ids.users.editor2 });
  await finishedJob({ dueCivil: "2026-10-05", sent: at("2026-10-02"), approved: at("2026-10-07", 4), editorId: ids.users.editor2 });
  // Waiting on the owner: one job ready to check, sent 2 days ago.
  const waiting = await job({ statusKey: "submitted", at: at("2026-10-06") });
  return { lateOne, lateDesk, changes, waiting };
}

describe("getEditorsOverview — the five numbers", () => {
  it("counts the desk now and the period's finished jobs with submit-based on-time and needed-changes rates", async () => {
    await seedEditors();
    const owner = await ctxOf("owner");
    const o = await getEditorsOverview(db, owner, { period: "this_month" });
    expect(o.period).toMatchObject({ period: "this_month", from: "2026-09-30T14:00:00.000Z", to: "2026-10-31T13:00:00.000Z" });
    expect(o.waitingOnYou).toEqual({ count: 1, oldestAgeSeconds: 2 * 86_400 });
    expect(o.rows.map((r) => r.editor.name)).toEqual(["Eve Editor", "Ed Editor"]); // late first
    const eve = o.rows[0];
    expect(eve).toMatchObject({ onDesk: 3, lateNow: 1, finished: 5, onTimePct: 80, neededChangesPct: 20, notEnough: false, usualCapacity: null, full: false });
    const ed = o.rows[1];
    expect(ed).toMatchObject({ onDesk: 0, lateNow: 0, finished: 2, onTimePct: null, neededChangesPct: null, notEnough: true });
  });

  it("switches period: last month credits Eve with the September job, approved late by the OWNER but sent on time", async () => {
    await seedEditors();
    const o = await getEditorsOverview(db, await ctxOf("owner"), { period: "last_month" });
    const eve = o.rows.find((r) => r.editor.id === ids.users.editor1);
    expect(eve).toMatchObject({ finished: 1, notEnough: true, onTimePct: null });
    const three = await getEditorsOverview(db, await ctxOf("owner"), { period: "last_3_months" });
    expect(three.rows.find((r) => r.editor.id === ids.users.editor1)).toMatchObject({ finished: 6, onTimePct: 83, neededChangesPct: 17 });
    expect((await getEditorsOverview(db, await ctxOf("owner"), { period: "nonsense" })).period.period).toBe("this_month");
  });

  it("reads 'Usually handles up to N' once the column exists and flags a full desk", async () => {
    await seedEditors();
    await db.update(users).set({ usualCapacityJobs: 3 }).where(eq(users.id, ids.users.editor1));
    const o = await getEditorsOverview(db, await ctxOf("owner"), {});
    expect(o.rows[0]).toMatchObject({ editor: { id: ids.users.editor1 }, usualCapacity: 3, onDesk: 3, full: true });
    expect(o.rows[1]).toMatchObject({ usualCapacity: null, full: false });
    const picker = await editorPickerOptions(db, await ctxOf("photographer1"));
    expect(picker.map((p) => [p.editor.name, p.onDesk, p.late, p.usualCapacity, p.full])).toEqual([
      ["Ed Editor", 0, 0, null, false],
      ["Eve Editor", 3, 1, 3, true],
    ]);
  });

  it("lists extra photographers with shoots this period, jobs waiting for their check and late jobs", async () => {
    await job({ statusKey: "submitted", photographerId: ids.users.photographer1, shootDate: due("2026-10-02") });
    await job({ statusKey: "in_progress", photographerId: ids.users.photographer1, dueDate: due("2026-10-01"), shootDate: due("2026-09-28") });
    await job({ statusKey: "new", editorId: null, photographerId: ids.users.photographer2, shootDate: due("2026-10-03") });
    await job({ statusKey: "cancelled", photographerId: ids.users.photographer2, shootDate: due("2026-10-04") });
    const o = await getEditorsOverview(db, await ctxOf("owner"), {});
    expect(o.extraPhotographers.map((p) => [p.photographer.name, p.shootsThisPeriod, p.waitingForTheirCheck, p.late])).toEqual([
      ["Leo Lead", 0, 0, 0],
      ["Paul Photographer", 1, 0, 0],
      ["Pia Photographer", 1, 1, 1],
    ]);
  });

  it("is for the owner (and analytics members): editors, plain photographers and clients get 403", async () => {
    await expect(getEditorsOverview(db, await ctxOf("editor1"), {})).rejects.toThrow(ForbiddenError);
    await expect(getEditorsOverview(db, await ctxOf("photographer1"), {})).rejects.toThrow(ForbiddenError);
    await expect(getEditorsOverview(db, await ctxOf("client"), {})).rejects.toThrow(ForbiddenError);
    await expect(editorsCsv(db, await ctxOf("editor1"), {})).rejects.toThrow(ForbiddenError);
    await expect(getEditorDetail(db, await ctxOf("editor1"), ids.users.editor1, {})).rejects.toThrow(ForbiddenError);
    expect((await getEditorsOverview(db, await ctxOf("lead"), {})).rows.length).toBeGreaterThanOrEqual(0); // ⚑analytics member
    expect((await getEditorsOverview(db, await ctxOf("coAdmin"), {})).asOf).toBe(NOW);
  });
});

describe("getEditorDetail", () => {
  it("gives the five numbers with vs-last-period deltas, the desk, recently finished and the weekly series", async () => {
    const { lateOne, lateDesk, changes } = await seedEditors();
    const owner = await ctxOf("owner");
    const d = await getEditorDetail(db, owner, ids.users.editor1, { period: "this_month" });
    expect(d.editor.name).toBe("Eve Editor");
    expect(d.numbers).toEqual({ onDesk: 3, lateNow: 1, finished: 5, onTimePct: 80, neededChangesPct: 20, notEnough: false });
    expect(d.deltas.finished).toEqual({ current: 5, previous: 1, delta: 4 });
    expect(d.deltas.onTimePct).toEqual({ current: 80, previous: null, delta: null }); // last month: not enough jobs
    expect(d.deltas.onDesk.previous).toBeNull();
    expect(d.onDeskNow.map((o) => o.job.id).sort()).toEqual([lateDesk.id, changes.id, d.onDeskNow.find((o) => o.job.stage.subLabel === "not_started")?.job.id].sort());
    expect(d.onDeskNow.every((o) => o.canChangeEditor)).toBe(true);
    expect(d.onDeskNow.find((o) => o.job.id === lateDesk.id)?.job.due.late).toBe(true);
    expect(d.recentlyFinished).toHaveLength(6);
    expect(d.recentlyFinished[0].approvedAt >= d.recentlyFinished[1].approvedAt).toBe(true);
    const late = d.recentlyFinished.find((r) => r.job.id === lateOne.id);
    expect(late).toMatchObject({ onTime: false, daysLate: 2, rounds: 1 });
    expect(d.recentlyFinished.filter((r) => r.onTime === true)).toHaveLength(5);
    expect(d.finishedPerWeek).toHaveLength(12);
    expect(d.finishedPerWeek.at(-1)).toEqual({ weekStart: "2026-10-05", finished: 5 });
    expect(d.finishedPerWeek.reduce((s, p) => s + p.finished, 0)).toBe(6);
  });

  it("404s for a photographer, a foreign id and a missing id", async () => {
    const owner = await ctxOf("owner");
    await expect(getEditorDetail(db, owner, ids.users.photographer1, {})).rejects.toThrow(NotFoundError);
    await expect(getEditorDetail(db, owner, "missing", {})).rejects.toThrow(NotFoundError);
    const other = await seedMinimalOrg(db, { slug: "other" });
    await expect(getEditorDetail(db, owner, other.users.editor1, {})).rejects.toThrow(NotFoundError);
  });
});

describe("editorsCsv", () => {
  it("writes one row per editor with the five numbers and the average days to edit", async () => {
    await seedEditors();
    const { fileName, csv } = await editorsCsv(db, await ctxOf("owner"), { period: "this_month" });
    expect(fileName).toBe("editors-this_month-2026-10-08.csv");
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Editor,On their desk,Late now,Finished,On time %,Needed changes %,Average days to edit,Period");
    expect(lines[1]).toMatch(/^Eve Editor,3,1,5,80,20,\d+(\.\d)?,This month$/);
    expect(lines[2]).toBe("Ed Editor,0,0,2,Not enough jobs yet,Not enough jobs yet,6.1,This month");
    expect(lines).toHaveLength(3);
  });
});
