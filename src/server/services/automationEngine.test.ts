import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDbOverride, type Tx } from "@/db/index";
import {
  activityEvents,
  automationRuns,
  automations,
  jobNotes,
  jobStatusTransitions,
  jobs,
  notifications,
  organisationSettings,
  type AutomationAction,
  type AutomationCondition,
  type AutomationTrigger,
} from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type FixtureUserKey, type SeedIds, type TestDb } from "@/db/test-db";
import { verifyDerived } from "@/db/verify";
import type { AuthContext, Automation, AutomationRun, Job } from "@/lib/types";
import { AppError } from "@/server/errors";
import { first, withSavepoint, withTx, withTxThenAutomations } from "./_shared";
import { assignEditor } from "./assignments";
import { enqueueAutomations, replayStalePendingRuns, runPendingAutomations } from "./automationEngine";
import { archiveAutomation, createAutomation, dryRun, toggleAutomation, updateAutomation } from "./automations";
import { bulkSetPriority, setDueDate, setPriority } from "./jobs";
import { notify, registerNotificationChannel } from "./notifications";
import { requestRevision } from "./revisions";
import { transitionJobStatus } from "./workflow";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

const ctxOf = (key: FixtureUserKey) => contextFor(db, ids.users[key]);
/** Builds the actor's context on the root db FIRST (never inside the tx), then runs `fn` in one transaction. */
const runAs = async <T>(actor: FixtureUserKey, fn: (tx: Tx, ctx: AuthContext) => Promise<T> | T): Promise<T> => {
  const ctx = await ctxOf(actor);
  return withTx((tx) => fn(tx, ctx), { db });
};
/** Same, then the post-commit automation runner (what route handlers do). */
const runAsThenAutomations = async <T>(actor: FixtureUserKey, fn: (tx: Tx, ctx: AuthContext) => Promise<T> | T): Promise<T> => {
  const ctx = await ctxOf(actor);
  return withTxThenAutomations(ctx, (tx) => fn(tx, ctx), { db });
};
const drain = () => runPendingAutomations(db, ids.organisationId);
const jobRow = async (id: string): Promise<Job> => (await first(db.select().from(jobs).where(eq(jobs.id, id)))) as Job;
const versionOf = async (id: string): Promise<number> => (await jobRow(id)).version;
const runsOf = (automationId: string): Promise<AutomationRun[]> =>
  db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.automationId, automationId))
    .orderBy(asc(automationRuns.createdAt), asc(automationRuns.depth), asc(automationRuns.rowid));
const automationNotices = () => db.select().from(notifications).where(eq(notifications.type, "automation"));
const eventsOf = (type: string) =>
  db.select().from(activityEvents).where(eq(activityEvents.eventType, type)).orderBy(asc(activityEvents.createdAt), asc(activityEvents.rowid));
const transitionsOf = (jobId: string) =>
  db.select().from(jobStatusTransitions).where(eq(jobStatusTransitions.jobId, jobId)).orderBy(asc(jobStatusTransitions.sequence));

function rule(
  trigger: AutomationTrigger,
  actions: AutomationAction[],
  conditions: AutomationCondition[] = [],
  extra: Record<string, unknown> = {},
): Promise<Automation> {
  return runAs("coAdmin", (tx, ctx) => createAutomation(tx, ctx, { name: `Rule ${trigger.type}`, trigger, conditions, actions, ...extra }));
}

async function catchErr(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected an AppError");
}

async function expectClean() {
  const report = await verifyDerived(db);
  expect(report.drift).toEqual([]);
  expect(report.structural).toEqual([]);
}

async function transition(actor: FixtureUserKey, jobId: string, toCategory: string, extra: Record<string, unknown> = {}) {
  const expectedVersion = await versionOf(jobId);
  return runAsThenAutomations(actor, (tx, ctx) => transitionJobStatus(tx, ctx, { jobId, toCategory, expectedVersion, ...extra }));
}

describe("automation CRUD (automations.ts)", () => {
  it("create / update / toggle / archive write management-only automation.* events", async () => {
    const a = await rule({ type: "job_created" }, [{ type: "notify", target: "photographer" }]);
    expect(a).toMatchObject({ triggerType: "job_created", isEnabled: true, version: 1 });

    const updated = await runAs("coAdmin", (tx, ctx) =>
      updateAutomation(tx, ctx, { automationId: a.id, expectedVersion: 1, name: "Welcome", trigger: { type: "status_changed", toCategory: "submitted" } }),
    );
    expect(updated).toMatchObject({ name: "Welcome", triggerType: "status_changed", version: 2 });
    const stale = await catchErr(() => runAs("coAdmin", (tx, ctx) => updateAutomation(tx, ctx, { automationId: a.id, expectedVersion: 1, name: "x" })));
    expect(stale.status).toBe(409);

    const off = await runAs("owner", (tx, ctx) => toggleAutomation(tx, ctx, { automationId: a.id }));
    expect(off.isEnabled).toBe(false);
    const archived = await runAs("owner", (tx, ctx) => archiveAutomation(tx, ctx, { automationId: a.id }));
    expect(archived.archivedAt).not.toBeNull();
    expect((await catchErr(() => runAs("owner", (tx, ctx) => toggleAutomation(tx, ctx, { automationId: a.id })))).status).toBe(400);

    const types = await db
      .select({ t: activityEvents.eventType, v: activityEvents.visibility, s: activityEvents.summary })
      .from(activityEvents)
      .where(eq(activityEvents.entityId, a.id))
      .orderBy(asc(activityEvents.createdAt), asc(activityEvents.rowid));
    expect(types.map((r) => r.t)).toEqual(["automation.created", "automation.updated", "automation.disabled", "automation.archived"]);
    expect(types.every((r) => r.v === "management")).toBe(true);
    expect(types[1]?.s).toContain("Welcome");
  });

  it("rejects bad definitions, foreign ids and non-admins", async () => {
    const workloadAssign = await catchErr(() => rule({ type: "workload_threshold", band: "overloaded" }, [{ type: "assign_editor", target: "previous_editor" }]));
    expect(workloadAssign.status).toBe(400);
    expect((await catchErr(() => rule({ type: "job_created" }, [{ type: "notify", target: "user" }]))).status).toBe(400);
    expect((await catchErr(() => rule({ type: "job_created" }, [{ type: "assign_editor", target: "user", userId: ids.users.photographer1 }]))).status).toBe(400);
    expect((await catchErr(() => rule({ type: "job_created" }, [{ type: "notify", target: "user", userId: "someone-else" }]))).status).toBe(404);
    expect(
      (await catchErr(() => rule({ type: "job_created" }, [{ type: "notify", target: "admins" }], [{ field: "clientId", op: "in", values: ["foreign-client"] }])))
        .status,
    ).toBe(404);
    for (const actor of ["editor1", "photographer1"] as const) {
      const err = await catchErr(() =>
        runAs(actor, (tx, ctx) => createAutomation(tx, ctx, { name: "x", trigger: { type: "job_created" }, actions: [{ type: "notify", target: "admins" }] })),
      );
      expect(err.status).toBe(403);
    }
  });
});

describe("triggers enqueue inside the human transaction (recordEvent hook)", () => {
  it("job_created → notify photographer; one pending run per event, executed after commit", async () => {
    const a = await rule({ type: "job_created" }, [{ type: "notify", target: "photographer", message: "New job!" }]);
    const { job, eventId } = await insertJobFixture(db, ids, { statusKey: "new" });
    const [pending] = await runsOf(a.id);
    expect(pending).toMatchObject({ status: "pending", triggerEventId: eventId, jobId: job.id, depth: 0 });

    const result = await drain();
    expect(result).toMatchObject({ processed: 1, succeeded: 1 });
    const [done] = await runsOf(a.id);
    expect(done).toMatchObject({ status: "succeeded", error: null });
    expect(done?.finishedAt).not.toBeNull();
    expect(done?.actionsPerformed[0]).toMatchObject({ ok: true, detail: "Notified 1 user" });
    expect(await automationNotices()).toMatchObject([{ userId: ids.users.photographer1, body: "New job!", jobId: job.id, activityEventId: eventId }]);

    const ran = await eventsOf("automation.ran");
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({ automationRunId: done?.id, actorUserId: null, jobId: job.id, visibility: "management" });
    expect(ran[0]?.metadata).toMatchObject({ cause: "automation", triggerEventId: eventId, depth: 0 });
    expect((await drain()).processed).toBe(0);
  });

  it("dedupes per (automation, trigger event): re-enqueueing the same event is a no-op", async () => {
    const a = await rule({ type: "job_created" }, [{ type: "notify", target: "photographer" }]);
    const { job, eventId } = await insertJobFixture(db, ids);
    const again = await runAs("coAdmin", (tx, ctx) => enqueueAutomations(tx, ctx, { eventId, eventType: "job.created", jobId: job.id }));
    expect(again).toEqual([]);
    expect(await runsOf(a.id)).toHaveLength(1);
  });

  it("status_changed honours toCategory / fromCategory / toStatusKey filters", async () => {
    const submitted = await rule({ type: "status_changed", toCategory: "submitted", fromCategory: "in_progress" }, [{ type: "notify", target: "admins" }]);
    const byKey = await rule({ type: "status_changed", toStatusKey: "submitted" }, [{ type: "notify", target: "creator" }]);
    const approved = await rule({ type: "status_changed", toCategory: "approved" }, [{ type: "notify", target: "photographer" }]);
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    await transition("editor1", job.id, "submitted");
    expect((await runsOf(submitted.id)).map((r) => r.status)).toEqual(["succeeded"]);
    expect((await runsOf(byKey.id)).map((r) => r.status)).toEqual(["succeeded"]);
    expect(await runsOf(approved.id)).toEqual([]);
    // The creator (photographer1) already got the built-in work_submitted for this
    // move, so the creator rule does not notify them a second time (§7 dedupe).
    expect((await automationNotices()).map((n) => n.userId).sort()).toEqual([ids.users.coAdmin, ids.users.owner].sort());
    expect((await runsOf(byKey.id))[0]?.actionsPerformed?.[0]).toMatchObject({ ok: true, detail: "Already notified about this by the built-in notice" });
    await expectClean();
  });

  it("job_assigned vs job_reassigned (editor role)", async () => {
    const assigned = await rule({ type: "job_assigned", role: "editor" }, [{ type: "notify", target: "editor" }]);
    const reassigned = await rule({ type: "job_reassigned", role: "editor" }, [{ type: "notify", target: "previous_editor" }]);
    const { job } = await insertJobFixture(db, ids, { statusKey: "new" });
    await runAsThenAutomations("coAdmin", (tx, ctx) => assignEditor(tx, ctx, { jobId: job.id, userId: ids.users.editor1 }));
    expect((await runsOf(assigned.id)).map((r) => r.status)).toEqual(["succeeded"]);
    expect(await runsOf(reassigned.id)).toEqual([]);
    await runAsThenAutomations("coAdmin", (tx, ctx) => assignEditor(tx, ctx, { jobId: job.id, userId: ids.users.editor2 }));
    expect(await runsOf(assigned.id)).toHaveLength(1);
    expect((await runsOf(reassigned.id)).map((r) => r.status)).toEqual(["succeeded"]);
    // editor1 already got job_assigned / job_reassigned for those very events (§7 dedupe):
    // the rules succeed without a second notice.
    expect(await automationNotices()).toEqual([]);
    expect((await runsOf(assigned.id))[0]?.actionsPerformed?.[0]).toMatchObject({ ok: true, detail: "Already notified about this by the built-in notice" });
    expect((await runsOf(reassigned.id))[0]?.actionsPerformed?.[0]).toMatchObject({ ok: true, detail: "Already notified about this by the built-in notice" });
    await expectClean();
  });

  it("deadline_changed field filter; priority_changed → add_note", async () => {
    const due = await rule({ type: "deadline_changed", field: "dueDate" }, [{ type: "notify", target: "editor" }]);
    const review = await rule({ type: "deadline_changed", field: "reviewDueDate" }, [{ type: "notify", target: "editor" }]);
    const note = await rule({ type: "priority_changed", toPriority: "urgent" }, [{ type: "add_note", kind: "internal", body: "Escalated by rule" }]);
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    let v = await versionOf(job.id);
    await runAsThenAutomations("coAdmin", (tx, ctx) => setDueDate(tx, ctx, { jobId: job.id, expectedVersion: v, value: "2026-10-20" }));
    expect((await runsOf(due.id)).map((r) => r.status)).toEqual(["succeeded"]);
    expect(await runsOf(review.id)).toEqual([]);

    v = await versionOf(job.id);
    await runAsThenAutomations("coAdmin", (tx, ctx) => setPriority(tx, ctx, { jobId: job.id, expectedVersion: v, priority: "high" }));
    expect(await runsOf(note.id)).toEqual([]);
    v = await versionOf(job.id);
    await runAsThenAutomations("coAdmin", (tx, ctx) => setPriority(tx, ctx, { jobId: job.id, expectedVersion: v, priority: "urgent" }));
    const [noteRun] = await runsOf(note.id);
    expect(noteRun?.status).toBe("succeeded");
    const notes = await db.select().from(jobNotes).where(eq(jobNotes.jobId, job.id));
    expect(notes).toMatchObject([{ kind: "internal", body: "Escalated by rule", authorUserId: ids.users.photographer1 }]);
    const added = (await eventsOf("note.added"))[0];
    expect(added).toMatchObject({ automationRunId: noteRun?.id, actorUserId: null });
    expect(noteRun?.actionsPerformed[0]?.activityEventId).toBe(added?.id);
    await expectClean();
  });
});

describe("actions", () => {
  it("assign_editor previous_editor on revision_requested (assign back)", async () => {
    const back = await rule({ type: "revision_requested" }, [{ type: "assign_editor", target: "previous_editor" }]);
    const { job } = await insertJobFixture(db, ids, { statusKey: "submitted", editorId: ids.users.editor1 });
    await runAs("coAdmin", (tx, ctx) => assignEditor(tx, ctx, { jobId: job.id, userId: ids.users.editor2 }));
    expect(await jobRow(job.id)).toMatchObject({ editorId: ids.users.editor2, previousEditorId: ids.users.editor1 });
    const v = await versionOf(job.id);
    await runAsThenAutomations("coAdmin", (tx, ctx) =>
      requestRevision(tx, ctx, { jobId: job.id, expectedVersion: v, reason: "Colour", description: "Warmer please" }),
    );
    const [r] = await runsOf(back.id);
    expect(r).toMatchObject({ status: "succeeded" });
    expect(await jobRow(job.id)).toMatchObject({ editorId: ids.users.editor1, previousEditorId: ids.users.editor2, statusCategory: "revision" });
    const reattributed = (await transitionsOf(job.id)).at(-1);
    expect(reattributed).toMatchObject({ kind: "reattribution", editorIdAtEntry: ids.users.editor1, actorUserId: null, automationRunId: r?.id });
    await expectClean();
  });

  it("assign_editor original_editor, and a missing previous editor fails the action", async () => {
    const original = await rule({ type: "priority_changed", toPriority: "urgent" }, [{ type: "assign_editor", target: "original_editor" }]);
    // runs execute in enqueue order: on job a the original-editor rule moves the job back to
    // editor1 first, so the previous-editor rule (editor2 only) is skipped there
    const previous = await rule(
      { type: "priority_changed", toPriority: "urgent" },
      [{ type: "assign_editor", target: "previous_editor" }],
      [{ field: "editorId", op: "in", values: [ids.users.editor2] }],
    );
    const a = (await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 })).job;
    await runAs("coAdmin", (tx, ctx) => assignEditor(tx, ctx, { jobId: a.id, userId: ids.users.editor2 }));
    const b = (await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor2 })).job;
    await bulkSetPriority(await ctxOf("coAdmin"), { jobIds: [a.id, b.id], priority: "urgent" }, { db });

    // bulk ran the rules post-commit (runPerJob wiring)
    expect((await jobRow(a.id)).editorId).toBe(ids.users.editor1);
    const prevRuns = await runsOf(previous.id);
    const bRun = prevRuns.find((r) => r.jobId === b.id);
    expect(bRun).toMatchObject({ status: "failed" });
    expect(bRun?.error).toContain("no previous editor");
    expect(prevRuns.find((r) => r.jobId === a.id)).toMatchObject({ status: "skipped" });
    expect((await runsOf(original.id)).every((r) => r.status === "succeeded")).toBe(true);
    await expectClean();
  });

  it("transition toCategory through the engine with the system context", async () => {
    const complete = await rule({ type: "status_changed", toCategory: "approved" }, [{ type: "transition", toCategory: "completed" }]);
    const { job } = await insertJobFixture(db, ids, { statusKey: "review" });
    await transition("coAdmin", job.id, "approved");
    const [r] = await runsOf(complete.id);
    expect(r?.status).toBe("succeeded");
    expect((await jobRow(job.id)).statusCategory).toBe("completed");
    const last = (await transitionsOf(job.id)).at(-1);
    expect(last).toMatchObject({ toCategory: "completed", actorUserId: null, automationRunId: r?.id });
    const changed = (await eventsOf("job.status_changed")).at(-1);
    expect(changed).toMatchObject({ automationRunId: r?.id, actorUserId: null });
    expect(changed?.metadata).toMatchObject({ cause: "automation", transitionId: last?.id });
    expect(r?.actionsPerformed[0]).toMatchObject({ ok: true, activityEventId: changed?.id });
    await expectClean();
  });

  it("set_priority and notify targets (admins / user / creator)", async () => {
    const pr = await rule({ type: "job_created" }, [
      { type: "set_priority", priority: "urgent" },
      { type: "notify", target: "admins" },
      { type: "notify", target: "user", userId: ids.users.editor2, message: "FYI" },
    ]);
    const { job } = await insertJobFixture(db, ids);
    await drain();
    const [r] = await runsOf(pr.id);
    expect(r?.status).toBe("succeeded");
    expect((await jobRow(job.id)).priority).toBe("urgent");
    expect(await eventsOf("job.priority_changed")).toMatchObject([{ automationRunId: r?.id, actorUserId: null }]);
    // roles v2: the legacy "owner" target became "admins" (owner + co-admin)
    expect((await automationNotices()).map((n) => n.userId).sort()).toEqual([ids.users.coAdmin, ids.users.editor2, ids.users.owner].sort());
    await expectClean();
  });
});

describe("conditions", () => {
  it("evaluates every condition against the current job; unmet → skipped with the reason", async () => {
    const urgentOnly = await rule({ type: "job_created" }, [{ type: "notify", target: "admins" }], [{ field: "priority", op: "in", values: ["urgent"] }]);
    const noEditor = await rule(
      { type: "job_created" },
      [{ type: "notify", target: "photographer" }],
      [
        { field: "editorId", op: "is_null" },
        { field: "statusCategory", op: "in", values: ["new", "ready"] },
        { field: "revisionCount", op: "lte", value: 0 },
        { field: "hasLinkKind", op: "missing", kind: "raw_files" },
        { field: "isOverdue", op: "eq", value: true },
        { field: "photographerId", op: "in", values: [ids.users.photographer1] },
        { field: "jobTypeId", op: "in", values: [ids.defaultJobTypeId] },
        { field: "clientId", op: "in", values: [ids.clientId] },
      ],
    );
    await insertJobFixture(db, ids, { statusKey: "new", priority: "normal", dueDate: "2026-10-07T12:59:59.999Z" });
    await drain();
    const [skipped] = await runsOf(urgentOnly.id);
    expect(skipped).toMatchObject({ status: "skipped" });
    expect(skipped?.error).toMatch(/^Condition not met: priority is normal/);
    expect(skipped?.conditionsSnapshot).toEqual([{ field: "priority", op: "in", values: ["urgent"] }]);
    expect((await runsOf(noEditor.id)).map((r) => r.status)).toEqual(["succeeded"]);
    // skipped runs are in the ledger only (no automation.ran noise)
    expect(await eventsOf("automation.ran")).toHaveLength(1);
  });
});

describe("engine guarantees", () => {
  it("depth cap: a rule ping-pong stops after AUTOMATION_MAX_DEPTH levels", async () => {
    const up = await rule({ type: "priority_changed", toPriority: "high" }, [{ type: "set_priority", priority: "urgent" }]);
    const down = await rule({ type: "priority_changed", toPriority: "urgent" }, [{ type: "set_priority", priority: "high" }]);
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    const v = await versionOf(job.id);
    await runAsThenAutomations("coAdmin", (tx, ctx) => setPriority(tx, ctx, { jobId: job.id, expectedVersion: v, priority: "high" }));
    const all = await db.select().from(automationRuns).orderBy(asc(automationRuns.depth));
    expect(all.map((r) => [r.depth, r.automationId === up.id ? "up" : r.automationId === down.id ? "down" : "?", r.status])).toEqual([
      [0, "up", "succeeded"],
      [1, "down", "succeeded"],
      [2, "up", "succeeded"],
      [3, "down", "succeeded"],
      [4, "up", "skipped"],
    ]);
    expect(all.at(-1)?.error).toMatch(/depth 4 exceeds the limit of 3/);
    expect((await jobRow(job.id)).priority).toBe("high");
    await expectClean();
  });

  it("a failing action is rolled back to its SAVEPOINT; other actions and other runs still apply", async () => {
    const mixed = await rule({ type: "job_created" }, [
      { type: "add_note", kind: "editor", body: "First" },
      { type: "transition", toCategory: "approved" },
      { type: "set_priority", priority: "high" },
    ]);
    const other = await rule({ type: "job_created" }, [{ type: "notify", target: "photographer" }]);
    const { job } = await insertJobFixture(db, ids, { statusKey: "new" });
    const result = await drain();
    expect(result).toMatchObject({ processed: 2, succeeded: 1, failed: 1 });
    const [r] = await runsOf(mixed.id);
    expect(r?.status).toBe("failed");
    expect(r?.actionsPerformed.map((a) => a.ok)).toEqual([true, false, true]);
    expect(r?.error).toMatch(/^transition: /);
    expect(await jobRow(job.id)).toMatchObject({ statusCategory: "new", priority: "high" });
    expect(await db.select().from(jobNotes).where(eq(jobNotes.jobId, job.id))).toHaveLength(1);
    expect(await transitionsOf(job.id)).toHaveLength(1);
    expect((await runsOf(other.id)).map((x) => x.status)).toEqual(["succeeded"]);
    expect((await eventsOf("automation.ran")).find((e) => e.automationRunId === r?.id)?.newValue).toMatchObject({ status: "failed" });
    await expectClean();
  });

  it("external notification delivery from an action waits for the run's COMMIT; a rolled-back SAVEPOINT drops it", async () => {
    const delivered: string[] = [];
    const unregister = registerNotificationChannel({
      id: "test-channel",
      deliver: async (n) => {
        delivered.push(n.title);
      },
    });
    setDbOverride(db); // the post-commit dispatcher reads through getDb()
    const settle = async () => {
      for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    };
    try {
      const ctx = await ctxOf("coAdmin");
      await withTx(async (tx) => {
        await withSavepoint(tx, (sp) => notify(sp, ctx, { userIds: [ids.users.editor1], type: "comment_added", title: "kept", linkPath: "/" }));
        await expect(
          withSavepoint(tx, async (sp) => {
            await notify(sp, ctx, { userIds: [ids.users.editor1], type: "comment_added", title: "dropped", linkPath: "/" });
            throw new Error("action failed");
          }),
        ).rejects.toThrow("action failed");
        await settle();
        expect(delivered).toEqual([]); // nothing leaves before COMMIT
      }, { db });
      await settle();
      expect(delivered).toEqual(["kept"]);

      const a = await rule({ type: "job_created" }, [{ type: "notify", target: "user", userId: ids.users.editor2, message: "From a rule" }]);
      await insertJobFixture(db, ids);
      expect((await runsOf(a.id))[0]?.status).toBe("pending");
      await drain();
      await settle();
      expect(delivered).toEqual(["kept", (await automationNotices())[0]?.title]);
    } finally {
      unregister();
    }
  });

  it("kill switch and disabled rules skip pending runs without acting", async () => {
    const a = await rule({ type: "job_created" }, [{ type: "notify", target: "photographer" }]);
    const b = await rule({ type: "job_created" }, [{ type: "notify", target: "admins" }]);
    await db.update(organisationSettings).set({ automationsEnabled: false }).where(eq(organisationSettings.organisationId, ids.organisationId));
    await insertJobFixture(db, ids);
    await drain();
    expect(await runsOf(a.id)).toMatchObject([{ status: "skipped", error: "Automations are switched off for this organisation" }]);
    expect(await automationNotices()).toEqual([]);

    await db.update(organisationSettings).set({ automationsEnabled: true }).where(eq(organisationSettings.organisationId, ids.organisationId));
    await insertJobFixture(db, ids);
    await runAs("coAdmin", (tx, ctx) => toggleAutomation(tx, ctx, { automationId: b.id, isEnabled: false }));
    // b was enqueued while enabled, then disabled before execution
    await drain();
    expect((await runsOf(b.id)).map((r) => [r.status, r.error])).toEqual([
      ["skipped", "Automations are switched off for this organisation"],
      ["skipped", "The rule is disabled"],
    ]);
    expect((await runsOf(a.id)).map((r) => r.status)).toEqual(["skipped", "succeeded"]);
  });

  it("pending replay: runs lost after commit are re-run once they are older than 60 s", async () => {
    const a = await rule({ type: "job_created" }, [{ type: "notify", target: "photographer" }]);
    await insertJobFixture(db, ids);
    expect((await replayStalePendingRuns(db, ids.organisationId)).processed).toBe(0);
    expect((await runsOf(a.id))[0]?.status).toBe("pending");
    fakeClock.advanceMs(61_000);
    expect(await replayStalePendingRuns(db, ids.organisationId)).toMatchObject({ processed: 1, succeeded: 1 });
    expect((await replayStalePendingRuns(db, ids.organisationId)).processed).toBe(0);
  });
});

describe("dryRun", () => {
  it("reports trigger, conditions and action previews without writing", async () => {
    const a = await rule(
      { type: "status_changed", toCategory: "submitted" },
      [
        { type: "notify", target: "photographer" },
        { type: "transition", toCategory: "approved" },
        { type: "assign_editor", target: "previous_editor" },
      ],
      [{ field: "priority", op: "in", values: ["normal"] }],
    );
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    // plain withTx: the enqueued run stays pending (not executed) for this test
    const v = await versionOf(job.id);
    await runAs("editor1", (tx, ctx) => transitionJobStatus(tx, ctx, { jobId: job.id, toCategory: "submitted", expectedVersion: v }));
    const runsBefore = (await db.select().from(automationRuns)).length;
    const eventsBefore = (await db.select().from(activityEvents)).length;

    const res = await dryRun(db, await ctxOf("coAdmin"), { automationId: a.id, jobId: job.id });
    expect(res.trigger).toMatchObject({ type: "status_changed", matched: true });
    expect(res.conditionsMet).toBe(true);
    expect(res.wouldRun).toBe(true);
    expect(res.actions.map((x) => x.problem === null)).toEqual([true, true, false]);
    expect(res.actions[0]?.description).toContain("Pia Photographer");
    expect(res.actions[1]?.description).toBe("Move to Approved");

    expect(await db.select().from(automationRuns)).toHaveLength(runsBefore);
    expect(await db.select().from(activityEvents)).toHaveLength(eventsBefore);
    const editorCtx = await ctxOf("editor1");
    const adminCtx = await ctxOf("coAdmin");
    expect((await catchErr(() => dryRun(db, editorCtx, { automationId: a.id, jobId: job.id }))).status).toBe(403);
    expect((await catchErr(() => dryRun(db, adminCtx, { automationId: a.id, jobId: "nope" }))).status).toBe(404);
  });

  it("flags unmet conditions and blocked rules", async () => {
    const a = await rule({ type: "job_created" }, [{ type: "set_priority", priority: "normal" }], [{ field: "editorId", op: "is_not_null" }]);
    const { job } = await insertJobFixture(db, ids, { statusKey: "new" });
    await runAs("coAdmin", (tx, ctx) => toggleAutomation(tx, ctx, { automationId: a.id, isEnabled: false }));
    const res = await dryRun(db, await ctxOf("owner"), { automationId: a.id, jobId: job.id });
    expect(res.conditions).toMatchObject([{ met: false, detail: "the job has no editor" }]);
    expect(res).toMatchObject({ conditionsMet: false, wouldRun: false, blockedBy: "The rule is disabled" });
    expect(res.actions[0]?.problem).toMatch(/Already/);
  });
});

describe("roles v2 (docs/ROLES.md §6.3)", () => {
  it("add_note with kind delivery is rejected on write; a stored one is skipped when the rule runs", async () => {
    expect((await catchErr(() => rule({ type: "job_created" }, [{ type: "add_note", kind: "delivery", body: "Ready!" }]))).status).toBe(400);
    // a frozen / legacy definition holding a delivery note action (written before the rule existed)
    const a = await rule({ type: "job_created" }, [{ type: "add_note", kind: "photographer", body: "Brief" }]);
    await db.update(automations).set({ actions: [{ type: "add_note", kind: "delivery", body: "Ready!" }] }).where(eq(automations.id, a.id));
    const { job } = await insertJobFixture(db, ids);
    await drain();
    const [r] = await runsOf(a.id);
    expect(r?.status).toBe("succeeded");
    expect(r?.actionsPerformed[0]?.detail).toMatch(/^Skipped/);
    expect(await db.select().from(jobNotes).where(eq(jobNotes.jobId, job.id))).toEqual([]);
    await expectClean();
  });

  it("legacy stored notify targets (managers / owner) run as admins; client users are never automation targets", async () => {
    const a = await rule({ type: "job_created" }, [{ type: "notify", target: "admins" }]);
    await db.$client.query("UPDATE automations SET actions = $1::jsonb WHERE id = $2", [JSON.stringify([{ type: "notify", target: "managers" }]), a.id]);
    await insertJobFixture(db, ids);
    await drain();
    expect((await automationNotices()).map((n) => n.userId).sort()).toEqual([ids.users.coAdmin, ids.users.owner].sort());
    expect((await catchErr(() => rule({ type: "job_created" }, [{ type: "notify", target: "user", userId: ids.users.client }]))).status).toBe(400);
    const legacy = { type: "notify", target: "managers" } as unknown as AutomationAction;
    expect((await catchErr(() => rule({ type: "job_created" }, [legacy]))).status).toBe(400);
  });
});
