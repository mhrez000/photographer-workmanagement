import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tx } from "@/db/index";
import {
  activityEvents,
  automationRuns,
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
import type { Automation, AutomationRun, Job } from "@/lib/types";
import { AppError } from "@/server/errors";
import { withTx, withTxThenAutomations } from "./_shared";
import { assignEditor } from "./assignments";
import { enqueueAutomations, replayStalePendingRuns, runPendingAutomations } from "./automationEngine";
import { archiveAutomation, createAutomation, dryRun, toggleAutomation, updateAutomation } from "./automations";
import { bulkSetPriority, setDueDate, setPriority } from "./jobs";
import { requestRevision } from "./revisions";
import { transitionJobStatus } from "./workflow";

let db: TestDb;
let ids: SeedIds;

beforeEach(() => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = makeTestDb();
  ids = seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

const ctxOf = (key: FixtureUserKey) => contextFor(db, ids.users[key]);
const run = <T>(fn: (tx: Tx) => T): T => withTx(fn, { db });
const drain = () => runPendingAutomations(db, ids.organisationId);
const jobRow = (id: string): Job => db.select().from(jobs).where(eq(jobs.id, id)).get() as Job;
const runsOf = (automationId: string): AutomationRun[] =>
  db.select().from(automationRuns).where(eq(automationRuns.automationId, automationId)).orderBy(asc(automationRuns.createdAt), asc(automationRuns.depth)).all();
const automationNotices = () => db.select().from(notifications).where(eq(notifications.type, "automation")).all();
const eventsOf = (type: string) => db.select().from(activityEvents).where(eq(activityEvents.eventType, type)).all();

function rule(
  trigger: AutomationTrigger,
  actions: AutomationAction[],
  conditions: AutomationCondition[] = [],
  extra: Record<string, unknown> = {},
): Automation {
  return run((tx) => createAutomation(tx, ctxOf("manager"), { name: `Rule ${trigger.type}`, trigger, conditions, actions, ...extra }));
}

function catchErr(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected an AppError");
}

function expectClean() {
  const report = verifyDerived(db.$client);
  expect(report.drift).toEqual([]);
  expect(report.structural).toEqual([]);
}

function transition(actor: FixtureUserKey, jobId: string, toCategory: string, extra: Record<string, unknown> = {}) {
  return withTxThenAutomations(
    ctxOf(actor),
    (tx) => transitionJobStatus(tx, ctxOf(actor), { jobId, toCategory, expectedVersion: jobRow(jobId).version, ...extra }),
    { db },
  );
}

describe("automation CRUD (automations.ts)", () => {
  it("create / update / toggle / archive write management-only automation.* events", () => {
    const a = rule({ type: "job_created" }, [{ type: "notify", target: "photographer" }]);
    expect(a).toMatchObject({ triggerType: "job_created", isEnabled: true, version: 1 });

    const updated = run((tx) =>
      updateAutomation(tx, ctxOf("manager"), { automationId: a.id, expectedVersion: 1, name: "Welcome", trigger: { type: "status_changed", toCategory: "submitted" } }),
    );
    expect(updated).toMatchObject({ name: "Welcome", triggerType: "status_changed", version: 2 });
    const stale = catchErr(() => run((tx) => updateAutomation(tx, ctxOf("manager"), { automationId: a.id, expectedVersion: 1, name: "x" })));
    expect(stale.status).toBe(409);

    const off = run((tx) => toggleAutomation(tx, ctxOf("owner"), { automationId: a.id }));
    expect(off.isEnabled).toBe(false);
    const archived = run((tx) => archiveAutomation(tx, ctxOf("owner"), { automationId: a.id }));
    expect(archived.archivedAt).not.toBeNull();
    expect(catchErr(() => run((tx) => toggleAutomation(tx, ctxOf("owner"), { automationId: a.id }))).status).toBe(400);

    const types = db
      .select({ t: activityEvents.eventType, v: activityEvents.visibility, s: activityEvents.summary })
      .from(activityEvents)
      .where(eq(activityEvents.entityId, a.id))
      .all();
    expect(types.map((r) => r.t)).toEqual(["automation.created", "automation.updated", "automation.disabled", "automation.archived"]);
    expect(types.every((r) => r.v === "management")).toBe(true);
    expect(types[1]?.s).toContain("Welcome");
  });

  it("rejects bad definitions, foreign ids and non-managers", () => {
    const workloadAssign = catchErr(() => rule({ type: "workload_threshold", band: "overloaded" }, [{ type: "assign_editor", target: "previous_editor" }]));
    expect(workloadAssign.status).toBe(400);
    expect(catchErr(() => rule({ type: "job_created" }, [{ type: "notify", target: "user" }])).status).toBe(400);
    expect(catchErr(() => rule({ type: "job_created" }, [{ type: "assign_editor", target: "user", userId: ids.users.photographer1 }])).status).toBe(400);
    expect(catchErr(() => rule({ type: "job_created" }, [{ type: "notify", target: "user", userId: "someone-else" }])).status).toBe(404);
    expect(
      catchErr(() => rule({ type: "job_created" }, [{ type: "notify", target: "managers" }], [{ field: "clientId", op: "in", values: ["foreign-client"] }])).status,
    ).toBe(404);
    for (const actor of ["editor1", "photographer1"] as const) {
      const err = catchErr(() =>
        run((tx) => createAutomation(tx, ctxOf(actor), { name: "x", trigger: { type: "job_created" }, actions: [{ type: "notify", target: "managers" }] })),
      );
      expect(err.status).toBe(403);
    }
  });
});

describe("triggers enqueue inside the human transaction (recordEvent hook)", () => {
  it("job_created → notify photographer; one pending run per event, executed after commit", () => {
    const a = rule({ type: "job_created" }, [{ type: "notify", target: "photographer", message: "New job!" }]);
    const { job, eventId } = insertJobFixture(db, ids, { statusKey: "new" });
    const [pending] = runsOf(a.id);
    expect(pending).toMatchObject({ status: "pending", triggerEventId: eventId, jobId: job.id, depth: 0 });

    const result = drain();
    expect(result).toMatchObject({ processed: 1, succeeded: 1 });
    const [done] = runsOf(a.id);
    expect(done).toMatchObject({ status: "succeeded", error: null });
    expect(done?.finishedAt).not.toBeNull();
    expect(done?.actionsPerformed[0]).toMatchObject({ ok: true, detail: "Notified 1 user" });
    expect(automationNotices()).toMatchObject([{ userId: ids.users.photographer1, body: "New job!", jobId: job.id, activityEventId: eventId }]);

    const ran = eventsOf("automation.ran");
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({ automationRunId: done?.id, actorUserId: null, jobId: job.id, visibility: "management" });
    expect(ran[0]?.metadata).toMatchObject({ cause: "automation", triggerEventId: eventId, depth: 0 });
    expect(drain().processed).toBe(0);
  });

  it("dedupes per (automation, trigger event): re-enqueueing the same event is a no-op", () => {
    const a = rule({ type: "job_created" }, [{ type: "notify", target: "photographer" }]);
    const { job, eventId } = insertJobFixture(db, ids);
    const again = run((tx) => enqueueAutomations(tx, ctxOf("manager"), { eventId, eventType: "job.created", jobId: job.id }));
    expect(again).toEqual([]);
    expect(runsOf(a.id)).toHaveLength(1);
  });

  it("status_changed honours toCategory / fromCategory / toStatusKey filters", () => {
    const submitted = rule({ type: "status_changed", toCategory: "submitted", fromCategory: "in_progress" }, [{ type: "notify", target: "managers" }]);
    const byKey = rule({ type: "status_changed", toStatusKey: "submitted" }, [{ type: "notify", target: "creator" }]);
    const approved = rule({ type: "status_changed", toCategory: "approved" }, [{ type: "notify", target: "photographer" }]);
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress" });
    transition("editor1", job.id, "submitted");
    expect(runsOf(submitted.id).map((r) => r.status)).toEqual(["succeeded"]);
    expect(runsOf(byKey.id).map((r) => r.status)).toEqual(["succeeded"]);
    expect(runsOf(approved.id)).toEqual([]);
    // The creator (photographer1) already got the built-in work_submitted for this
    // move, so the creator rule does not notify them a second time (§7 dedupe).
    expect(automationNotices().map((n) => n.userId).sort()).toEqual([ids.users.manager, ids.users.owner].sort());
    expect(runsOf(byKey.id)[0]?.actionsPerformed?.[0]).toMatchObject({ ok: true, detail: "Already notified about this by the built-in notice" });
    expectClean();
  });

  it("job_assigned vs job_reassigned (editor role)", () => {
    const assigned = rule({ type: "job_assigned", role: "editor" }, [{ type: "notify", target: "editor" }]);
    const reassigned = rule({ type: "job_reassigned", role: "editor" }, [{ type: "notify", target: "previous_editor" }]);
    const { job } = insertJobFixture(db, ids, { statusKey: "new" });
    withTxThenAutomations(ctxOf("manager"), (tx) => assignEditor(tx, ctxOf("manager"), { jobId: job.id, userId: ids.users.editor1 }), { db });
    expect(runsOf(assigned.id).map((r) => r.status)).toEqual(["succeeded"]);
    expect(runsOf(reassigned.id)).toEqual([]);
    withTxThenAutomations(ctxOf("manager"), (tx) => assignEditor(tx, ctxOf("manager"), { jobId: job.id, userId: ids.users.editor2 }), { db });
    expect(runsOf(assigned.id)).toHaveLength(1);
    expect(runsOf(reassigned.id).map((r) => r.status)).toEqual(["succeeded"]);
    // editor1 already got job_assigned / job_reassigned for those very events (§7 dedupe):
    // the rules succeed without a second notice.
    expect(automationNotices()).toEqual([]);
    expect(runsOf(assigned.id)[0]?.actionsPerformed?.[0]).toMatchObject({ ok: true, detail: "Already notified about this by the built-in notice" });
    expect(runsOf(reassigned.id)[0]?.actionsPerformed?.[0]).toMatchObject({ ok: true, detail: "Already notified about this by the built-in notice" });
    expectClean();
  });

  it("deadline_changed field filter; priority_changed → add_note", () => {
    const due = rule({ type: "deadline_changed", field: "dueDate" }, [{ type: "notify", target: "editor" }]);
    const review = rule({ type: "deadline_changed", field: "reviewDueDate" }, [{ type: "notify", target: "editor" }]);
    const note = rule({ type: "priority_changed", toPriority: "urgent" }, [{ type: "add_note", kind: "internal", body: "Escalated by rule" }]);
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress" });
    withTxThenAutomations(ctxOf("manager"), (tx) => setDueDate(tx, ctxOf("manager"), { jobId: job.id, expectedVersion: jobRow(job.id).version, value: "2026-10-20" }), { db });
    expect(runsOf(due.id).map((r) => r.status)).toEqual(["succeeded"]);
    expect(runsOf(review.id)).toEqual([]);

    withTxThenAutomations(ctxOf("manager"), (tx) => setPriority(tx, ctxOf("manager"), { jobId: job.id, expectedVersion: jobRow(job.id).version, priority: "high" }), { db });
    expect(runsOf(note.id)).toEqual([]);
    withTxThenAutomations(ctxOf("manager"), (tx) => setPriority(tx, ctxOf("manager"), { jobId: job.id, expectedVersion: jobRow(job.id).version, priority: "urgent" }), { db });
    const [noteRun] = runsOf(note.id);
    expect(noteRun?.status).toBe("succeeded");
    const notes = db.select().from(jobNotes).where(eq(jobNotes.jobId, job.id)).all();
    expect(notes).toMatchObject([{ kind: "internal", body: "Escalated by rule", authorUserId: ids.users.photographer1 }]);
    const added = eventsOf("note.added")[0];
    expect(added).toMatchObject({ automationRunId: noteRun?.id, actorUserId: null });
    expect(noteRun?.actionsPerformed[0]?.activityEventId).toBe(added?.id);
    expectClean();
  });
});

describe("actions", () => {
  it("assign_editor previous_editor on revision_requested (assign back)", () => {
    const back = rule({ type: "revision_requested" }, [{ type: "assign_editor", target: "previous_editor" }]);
    const { job } = insertJobFixture(db, ids, { statusKey: "submitted", editorId: ids.users.editor1 });
    run((tx) => assignEditor(tx, ctxOf("manager"), { jobId: job.id, userId: ids.users.editor2 }));
    expect(jobRow(job.id)).toMatchObject({ editorId: ids.users.editor2, previousEditorId: ids.users.editor1 });
    withTxThenAutomations(
      ctxOf("manager"),
      (tx) =>
        requestRevision(tx, ctxOf("manager"), { jobId: job.id, expectedVersion: jobRow(job.id).version, reason: "Colour", description: "Warmer please" }),
      { db },
    );
    const [r] = runsOf(back.id);
    expect(r).toMatchObject({ status: "succeeded" });
    expect(jobRow(job.id)).toMatchObject({ editorId: ids.users.editor1, previousEditorId: ids.users.editor2, statusCategory: "revision" });
    const reattributed = db.select().from(jobStatusTransitions).where(eq(jobStatusTransitions.jobId, job.id)).orderBy(asc(jobStatusTransitions.sequence)).all().at(-1);
    expect(reattributed).toMatchObject({ kind: "reattribution", editorIdAtEntry: ids.users.editor1, actorUserId: null, automationRunId: r?.id });
    expectClean();
  });

  it("assign_editor original_editor, and a missing previous editor fails the action", () => {
    const original = rule({ type: "priority_changed", toPriority: "urgent" }, [{ type: "assign_editor", target: "original_editor" }]);
    // runs execute in enqueue order: on job a the original-editor rule moves the job back to
    // editor1 first, so the previous-editor rule (editor2 only) is skipped there
    const previous = rule(
      { type: "priority_changed", toPriority: "urgent" },
      [{ type: "assign_editor", target: "previous_editor" }],
      [{ field: "editorId", op: "in", values: [ids.users.editor2] }],
    );
    const a = insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 }).job;
    run((tx) => assignEditor(tx, ctxOf("manager"), { jobId: a.id, userId: ids.users.editor2 }));
    const b = insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor2 }).job;
    bulkSetPriority(ctxOf("manager"), { jobIds: [a.id, b.id], priority: "urgent" }, { db });

    // bulk ran the rules post-commit (runPerJob wiring)
    expect(jobRow(a.id).editorId).toBe(ids.users.editor1);
    const prevRuns = runsOf(previous.id);
    const bRun = prevRuns.find((r) => r.jobId === b.id);
    expect(bRun).toMatchObject({ status: "failed" });
    expect(bRun?.error).toContain("no previous editor");
    expect(prevRuns.find((r) => r.jobId === a.id)).toMatchObject({ status: "skipped" });
    expect(runsOf(original.id).every((r) => r.status === "succeeded")).toBe(true);
    expectClean();
  });

  it("transition toCategory through the engine with the system context", () => {
    const complete = rule({ type: "status_changed", toCategory: "approved" }, [{ type: "transition", toCategory: "completed" }]);
    const { job } = insertJobFixture(db, ids, { statusKey: "review" });
    transition("manager", job.id, "approved");
    const [r] = runsOf(complete.id);
    expect(r?.status).toBe("succeeded");
    expect(jobRow(job.id).statusCategory).toBe("completed");
    const last = db.select().from(jobStatusTransitions).where(eq(jobStatusTransitions.jobId, job.id)).orderBy(asc(jobStatusTransitions.sequence)).all().at(-1);
    expect(last).toMatchObject({ toCategory: "completed", actorUserId: null, automationRunId: r?.id });
    const changed = eventsOf("job.status_changed").at(-1);
    expect(changed).toMatchObject({ automationRunId: r?.id, actorUserId: null });
    expect(changed?.metadata).toMatchObject({ cause: "automation", transitionId: last?.id });
    expect(r?.actionsPerformed[0]).toMatchObject({ ok: true, activityEventId: changed?.id });
    expectClean();
  });

  it("set_priority and notify targets (managers / owner / user / creator)", () => {
    const pr = rule({ type: "job_created" }, [
      { type: "set_priority", priority: "urgent" },
      { type: "notify", target: "owner" },
      { type: "notify", target: "user", userId: ids.users.editor2, message: "FYI" },
    ]);
    const { job } = insertJobFixture(db, ids);
    drain();
    const [r] = runsOf(pr.id);
    expect(r?.status).toBe("succeeded");
    expect(jobRow(job.id).priority).toBe("urgent");
    expect(eventsOf("job.priority_changed")).toMatchObject([{ automationRunId: r?.id, actorUserId: null }]);
    expect(automationNotices().map((n) => n.userId).sort()).toEqual([ids.users.editor2, ids.users.owner].sort());
    expectClean();
  });
});

describe("conditions", () => {
  it("evaluates every condition against the current job; unmet → skipped with the reason", () => {
    const urgentOnly = rule({ type: "job_created" }, [{ type: "notify", target: "managers" }], [{ field: "priority", op: "in", values: ["urgent"] }]);
    const noEditor = rule(
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
    insertJobFixture(db, ids, { statusKey: "new", priority: "normal", dueDate: "2026-10-07T12:59:59.999Z" });
    drain();
    const [skipped] = runsOf(urgentOnly.id);
    expect(skipped).toMatchObject({ status: "skipped" });
    expect(skipped?.error).toMatch(/^Condition not met: priority is normal/);
    expect(skipped?.conditionsSnapshot).toEqual([{ field: "priority", op: "in", values: ["urgent"] }]);
    expect(runsOf(noEditor.id).map((r) => r.status)).toEqual(["succeeded"]);
    // skipped runs are in the ledger only (no automation.ran noise)
    expect(eventsOf("automation.ran")).toHaveLength(1);
  });
});

describe("engine guarantees", () => {
  it("depth cap: a rule ping-pong stops after AUTOMATION_MAX_DEPTH levels", () => {
    const up = rule({ type: "priority_changed", toPriority: "high" }, [{ type: "set_priority", priority: "urgent" }]);
    const down = rule({ type: "priority_changed", toPriority: "urgent" }, [{ type: "set_priority", priority: "high" }]);
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress" });
    withTxThenAutomations(ctxOf("manager"), (tx) => setPriority(tx, ctxOf("manager"), { jobId: job.id, expectedVersion: jobRow(job.id).version, priority: "high" }), { db });
    const all = db.select().from(automationRuns).orderBy(asc(automationRuns.depth)).all();
    expect(all.map((r) => [r.depth, r.automationId === up.id ? "up" : r.automationId === down.id ? "down" : "?", r.status])).toEqual([
      [0, "up", "succeeded"],
      [1, "down", "succeeded"],
      [2, "up", "succeeded"],
      [3, "down", "succeeded"],
      [4, "up", "skipped"],
    ]);
    expect(all.at(-1)?.error).toMatch(/depth 4 exceeds the limit of 3/);
    expect(jobRow(job.id).priority).toBe("high");
    expectClean();
  });

  it("a failing action is rolled back to its SAVEPOINT; other actions and other runs still apply", () => {
    const mixed = rule({ type: "job_created" }, [
      { type: "add_note", kind: "editor", body: "First" },
      { type: "transition", toCategory: "approved" },
      { type: "set_priority", priority: "high" },
    ]);
    const other = rule({ type: "job_created" }, [{ type: "notify", target: "photographer" }]);
    const { job } = insertJobFixture(db, ids, { statusKey: "new" });
    const result = drain();
    expect(result).toMatchObject({ processed: 2, succeeded: 1, failed: 1 });
    const [r] = runsOf(mixed.id);
    expect(r?.status).toBe("failed");
    expect(r?.actionsPerformed.map((a) => a.ok)).toEqual([true, false, true]);
    expect(r?.error).toMatch(/^transition: /);
    expect(jobRow(job.id)).toMatchObject({ statusCategory: "new", priority: "high" });
    expect(db.select().from(jobNotes).where(eq(jobNotes.jobId, job.id)).all()).toHaveLength(1);
    expect(db.select().from(jobStatusTransitions).where(eq(jobStatusTransitions.jobId, job.id)).all()).toHaveLength(1);
    expect(runsOf(other.id).map((x) => x.status)).toEqual(["succeeded"]);
    expect(eventsOf("automation.ran").find((e) => e.automationRunId === r?.id)?.newValue).toMatchObject({ status: "failed" });
    expectClean();
  });

  it("kill switch and disabled rules skip pending runs without acting", () => {
    const a = rule({ type: "job_created" }, [{ type: "notify", target: "photographer" }]);
    const b = rule({ type: "job_created" }, [{ type: "notify", target: "managers" }]);
    db.update(organisationSettings).set({ automationsEnabled: false }).where(eq(organisationSettings.organisationId, ids.organisationId)).run();
    insertJobFixture(db, ids);
    drain();
    expect(runsOf(a.id)).toMatchObject([{ status: "skipped", error: "Automations are switched off for this organisation" }]);
    expect(automationNotices()).toEqual([]);

    db.update(organisationSettings).set({ automationsEnabled: true }).where(eq(organisationSettings.organisationId, ids.organisationId)).run();
    insertJobFixture(db, ids);
    run((tx) => toggleAutomation(tx, ctxOf("manager"), { automationId: b.id, isEnabled: false }));
    // b was enqueued while enabled, then disabled before execution
    drain();
    expect(runsOf(b.id).map((r) => [r.status, r.error])).toEqual([
      ["skipped", "Automations are switched off for this organisation"],
      ["skipped", "The rule is disabled"],
    ]);
    expect(runsOf(a.id).map((r) => r.status)).toEqual(["skipped", "succeeded"]);
  });

  it("pending replay: runs lost after commit are re-run once they are older than 60 s", () => {
    const a = rule({ type: "job_created" }, [{ type: "notify", target: "photographer" }]);
    insertJobFixture(db, ids);
    expect(replayStalePendingRuns(db, ids.organisationId).processed).toBe(0);
    expect(runsOf(a.id)[0]?.status).toBe("pending");
    fakeClock.advanceMs(61_000);
    expect(replayStalePendingRuns(db, ids.organisationId)).toMatchObject({ processed: 1, succeeded: 1 });
    expect(replayStalePendingRuns(db, ids.organisationId).processed).toBe(0);
  });
});

describe("dryRun", () => {
  it("reports trigger, conditions and action previews without writing", () => {
    const a = rule(
      { type: "status_changed", toCategory: "submitted" },
      [
        { type: "notify", target: "photographer" },
        { type: "transition", toCategory: "approved" },
        { type: "assign_editor", target: "previous_editor" },
      ],
      [{ field: "priority", op: "in", values: ["normal"] }],
    );
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress" });
    // plain withTx: the enqueued run stays pending (not executed) for this test
    run((tx) => transitionJobStatus(tx, ctxOf("editor1"), { jobId: job.id, toCategory: "submitted", expectedVersion: jobRow(job.id).version }));
    const runsBefore = db.select().from(automationRuns).all().length;
    const eventsBefore = db.select().from(activityEvents).all().length;

    const res = dryRun(db, ctxOf("manager"), { automationId: a.id, jobId: job.id });
    expect(res.trigger).toMatchObject({ type: "status_changed", matched: true });
    expect(res.conditionsMet).toBe(true);
    expect(res.wouldRun).toBe(true);
    expect(res.actions.map((x) => x.problem === null)).toEqual([true, true, false]);
    expect(res.actions[0]?.description).toContain("Pia Photographer");
    expect(res.actions[1]?.description).toBe("Move to Approved");

    expect(db.select().from(automationRuns).all()).toHaveLength(runsBefore);
    expect(db.select().from(activityEvents).all()).toHaveLength(eventsBefore);
    expect(catchErr(() => dryRun(db, ctxOf("editor1"), { automationId: a.id, jobId: job.id })).status).toBe(403);
    expect(catchErr(() => dryRun(db, ctxOf("manager"), { automationId: a.id, jobId: "nope" })).status).toBe(404);
  });

  it("flags unmet conditions and blocked rules", () => {
    const a = rule({ type: "job_created" }, [{ type: "set_priority", priority: "normal" }], [{ field: "editorId", op: "is_not_null" }]);
    const { job } = insertJobFixture(db, ids, { statusKey: "new" });
    run((tx) => toggleAutomation(tx, ctxOf("manager"), { automationId: a.id, isEnabled: false }));
    const res = dryRun(db, ctxOf("owner"), { automationId: a.id, jobId: job.id });
    expect(res.conditions).toMatchObject([{ met: false, detail: "the job has no editor" }]);
    expect(res).toMatchObject({ conditionsMet: false, wouldRun: false, blockedBy: "The rule is disabled" });
    expect(res.actions[0]?.problem).toMatch(/Already/);
  });
});
