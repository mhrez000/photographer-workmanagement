import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jobLinks, jobRevisions } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type JobFixtureOptions, type SeedIds, type TestDb } from "@/db/test-db";
import { endOfCivilDayIso } from "@/lib/dates";
import { ForbiddenError } from "@/server/errors";
import { getEditorsOverview } from "./editors";
import { getMyJobs } from "./myJobs";

const TZ = "Australia/Sydney";
const NOW = "2026-10-08T00:00:00.000Z"; // Thu 8 Oct 2026, 11:00 AEDT
const due = (civil: string) => endOfCivilDayIso(civil, TZ);

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set(NOW);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db, { at: "2026-08-01T00:00:00.000Z" });
});
afterEach(() => fakeClock.reset());

const job = async (opts: JobFixtureOptions = {}) => (await insertJobFixture(db, ids, opts)).job;
const ctxOf = async (key: keyof SeedIds["users"]) => await contextFor(db, ids.users[key]);

describe("getMyJobs (editor home)", () => {
  it("puts every held job in exactly one section, in the plan's order, and quotes the change request", async () => {
    const changes = await job({ statusKey: "revision", dueDate: due("2026-10-12"), name: "Changes" });
    await db.insert(jobRevisions).values({
      organisationId: ids.organisationId,
      jobId: changes.id,
      revisionNumber: 1,
      requestedByUserId: ids.users.owner,
      assigneeUserId: ids.users.editor1,
      reason: "Sky",
      description: "Replace the grey sky on the hero shot",
      requestedAt: "2026-10-07T03:00:00.000Z",
    });
    const late = await job({ statusKey: "in_progress", dueDate: due("2026-10-07"), name: "Late" });
    const toDoNew = await job({ statusKey: "assigned", dueDate: due("2026-10-09"), name: "New" });
    const toDoEditing = await job({ statusKey: "in_progress", dueDate: due("2026-10-11"), name: "Editing" });
    await db.insert(jobLinks).values({ organisationId: ids.organisationId, jobId: toDoEditing.id, kind: "finished_files", url: "https://x.example/done", addedByUserId: ids.users.editor1 });
    const waiting = await job({ statusKey: "submitted", name: "Waiting" });
    const doneRecent = await job({ statusKey: "approved", at: "2026-10-03T00:00:00.000Z", dueDate: due("2026-10-05"), name: "Done recently" });
    await job({ statusKey: "approved", at: "2026-08-25T00:00:00.000Z", name: "Done long ago" });
    await job({ statusKey: "in_progress", editorId: ids.users.editor2, dueDate: due("2026-10-01"), name: "Ed's" });
    await job({ statusKey: "new", editorId: null, createdByUserId: ids.users.editor1, name: "I created but do not hold" });

    const my = await getMyJobs(db, await ctxOf("editor1"));
    expect(my.viewer.name).toBe("Eve Editor");
    expect(my.changesAsked.map((c) => c.job.id)).toEqual([changes.id]);
    expect(my.changesAsked[0]).toMatchObject({
      nextStep: "send_for_checking",
      hasFinishedLink: false,
      changesAsked: { round: 1, who: { name: "Olivia Owner" }, when: "2026-10-07T03:00:00.000Z", text: "Replace the grey sky on the hero shot", reason: "Sky" },
    });
    expect(my.late.map((c) => c.job.id)).toEqual([late.id]);
    expect(my.late[0]).toMatchObject({ nextStep: "send_for_checking", toDoLabel: null, job: { due: { late: true } } });
    expect(my.toDo.map((c) => [c.job.id, c.toDoLabel, c.nextStep, c.hasFinishedLink])).toEqual([
      [toDoNew.id, "new", "start_editing", false],
      [toDoEditing.id, "editing", "send_for_checking", true],
    ]);
    expect(my.waitingForCheck.map((c) => c.job.id)).toEqual([waiting.id]);
    expect(my.waitingForCheck[0].nextStep).toBe("none");
    expect(my.doneRecently.map((c) => c.job.id)).toEqual([doneRecent.id]);
    expect(my.nextUp?.job.id).toBe(changes.id);
    expect(my.changesAsked[0].job.waitingOn).toBe("You");
    expect(my.waitingForCheck[0].job.waitingOn).toBe("Pia Photographer");
  });

  it("next up falls back to the most urgent late job, then the first to-do", async () => {
    const late = await job({ statusKey: "in_progress", dueDate: due("2026-10-01") });
    await job({ statusKey: "assigned", dueDate: due("2026-10-09") });
    expect((await getMyJobs(db, await ctxOf("editor1"))).nextUp?.job.id).toBe(late.id);
    const empty = await getMyJobs(db, await ctxOf("editor2"));
    expect(empty.nextUp).toBeNull();
    expect(empty.thisMonth).toEqual({ finished: 0, onTimePct: null, neededChangesPct: null, notEnough: true });
  });

  it("the footer uses the Editors page formulas (same numbers the owner sees)", async () => {
    for (let i = 0; i < 5; i += 1) await job({ statusKey: "approved", at: `2026-10-0${i + 1}T00:00:00.000Z`, dueDate: due(`2026-10-0${i + 2}`) });
    const lateAndChanged = await job({ statusKey: "approved", at: "2026-10-06T00:00:00.000Z", dueDate: due("2026-10-01") });
    await db.insert(jobRevisions).values({
      organisationId: ids.organisationId,
      jobId: lateAndChanged.id,
      revisionNumber: 1,
      requestedByUserId: ids.users.owner,
      reason: "Colour",
      description: "Warmer",
      requestedAt: "2026-10-05T00:00:00.000Z",
      resolvedAt: "2026-10-05T01:00:00.000Z",
      resolution: "resubmitted",
    });
    await db.execute(`update jobs set revision_count = 1 where id = '${lateAndChanged.id}'`);
    const my = await getMyJobs(db, await ctxOf("editor1"));
    expect(my.thisMonth).toEqual({ finished: 6, onTimePct: 83, neededChangesPct: 17, notEnough: false });
    const eve = (await getEditorsOverview(db, await ctxOf("owner"), { period: "this_month" })).rows.find((r) => r.editor.id === ids.users.editor1);
    expect(eve).toMatchObject({ finished: my.thisMonth.finished, onTimePct: my.thisMonth.onTimePct, neededChangesPct: my.thisMonth.neededChangesPct });
  });

  it("is for editors only", async () => {
    await expect(getMyJobs(db, await ctxOf("owner"))).rejects.toThrow(ForbiddenError);
    await expect(getMyJobs(db, await ctxOf("photographer1"))).rejects.toThrow(ForbiddenError);
    await expect(getMyJobs(db, await ctxOf("client"))).rejects.toThrow(ForbiddenError);
  });
});
