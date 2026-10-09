import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tx } from "@/db/index";
import { activityEvents, jobs, workflowTransitions, workflows } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import type { AuthContext } from "@/lib/types";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { withTx } from "./_shared";
import { archiveJobType, createJobType, restoreJobType, updateJobType } from "./jobTypes";
import {
  addStatus,
  addTransition,
  archiveStatus,
  archiveTransition,
  archiveWorkflow,
  createWorkflow,
  getWorkflowGraph,
  reorderStatuses,
  updateStatus,
  updateTransition,
  updateWorkflow,
  validateWorkflow,
} from "./workflows";

let db: TestDb;
let ids: SeedIds;

beforeEach(() => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = makeTestDb();
  ids = seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

function run<T>(userId: string, fn: (tx: Tx, ctx: AuthContext) => T): T {
  const ctx = contextFor(db, userId);
  return withTx((tx) => fn(tx, ctx), { db });
}
const asOwner = <T>(fn: (tx: Tx, ctx: AuthContext) => T) => run(ids.users.owner, fn);

describe("workflow permissions", () => {
  it("view = owner/manager, manage = owner only", () => {
    expect(getWorkflowGraph(db, contextFor(db, ids.users.manager), ids.workflowId).problems).toEqual([]);
    expect(() => getWorkflowGraph(db, contextFor(db, ids.users.photographer1), ids.workflowId)).toThrow(ForbiddenError);
    expect(() => run(ids.users.manager, (tx, ctx) => createWorkflow(tx, ctx, { name: "X" }))).toThrow(ForbiddenError);
    expect(() =>
      run(ids.users.manager, (tx, ctx) => addStatus(tx, ctx, { workflowId: ids.workflowId, name: "Hold", category: "review" })),
    ).toThrow(ForbiddenError);
  });

  it("foreign workflows are 404", () => {
    const other = seedMinimalOrg(db, { slug: "other" });
    expect(() => getWorkflowGraph(db, contextFor(db, ids.users.owner), other.workflowId)).toThrow(NotFoundError);
    expect(() => asOwner((tx, ctx) => addStatus(tx, ctx, { workflowId: other.workflowId, name: "X", category: "review" }))).toThrow(NotFoundError);
  });
});

describe("createWorkflow / updateWorkflow / archiveWorkflow", () => {
  it("default template is valid and audited; blank needs work; copy mirrors the source", () => {
    const def = asOwner((tx, ctx) => createWorkflow(tx, ctx, { name: "Quick Turnaround", from: "default" }));
    expect(def.problems).toEqual([]);
    expect(def.statuses).toHaveLength(13);
    expect(def.inUse).toBe(false);
    const ev = db.select().from(activityEvents).where(eq(activityEvents.entityId, def.workflow.id)).all();
    expect(ev[0]).toMatchObject({ eventType: "workflow.created", visibility: "management" });

    const blank = asOwner((tx, ctx) => createWorkflow(tx, ctx, { name: "Blank", from: "blank" }));
    expect(blank.statuses.map((s) => s.category).sort()).toEqual(["approved", "cancelled", "completed", "in_progress", "new", "submitted"]);
    expect(blank.problems.length).toBeGreaterThan(0);
    expect(validateWorkflow(db, contextFor(db, ids.users.owner), blank.workflow.id)).toEqual(blank.problems);

    const copy = asOwner((tx, ctx) => createWorkflow(tx, ctx, { name: "Copy", from: "workflow", sourceWorkflowId: ids.workflowId }));
    expect(copy.statuses.map((s) => s.key)).toEqual(getWorkflowGraph(db, contextFor(db, ids.users.owner), ids.workflowId).statuses.map((s) => s.key));
    expect(copy.transitions).toHaveLength(db.select().from(workflowTransitions).where(eq(workflowTransitions.workflowId, ids.workflowId)).all().length);
    expect(copy.problems).toEqual([]);

    expect(() => asOwner((tx, ctx) => createWorkflow(tx, ctx, { name: "copy" }))).toThrow(/already exists/);
  });

  it("only a valid workflow can become the default; the previous default is unset", () => {
    const blank = asOwner((tx, ctx) => createWorkflow(tx, ctx, { name: "Blank", from: "blank" }));
    expect(() => asOwner((tx, ctx) => updateWorkflow(tx, ctx, { workflowId: blank.workflow.id, isDefault: true }))).toThrow(/problems/);

    const next = asOwner((tx, ctx) => createWorkflow(tx, ctx, { name: "Next", isDefault: true }));
    expect(next.workflow.isDefault).toBe(true);
    expect(db.select().from(workflows).where(eq(workflows.id, ids.workflowId)).get()?.isDefault).toBe(false);
    const renamed = asOwner((tx, ctx) => updateWorkflow(tx, ctx, { workflowId: next.workflow.id, name: "Standard v2" }));
    expect(renamed.workflow.name).toBe("Standard v2");
  });

  it("archive is blocked for the default, for bound job types and for active jobs", () => {
    expect(() => asOwner((tx, ctx) => archiveWorkflow(tx, ctx, { workflowId: ids.workflowId }))).toThrow(/default/);

    const wf = asOwner((tx, ctx) => createWorkflow(tx, ctx, { name: "Video" }));
    const jt = run(ids.users.manager, (tx, ctx) => createJobType(tx, ctx, { name: "Reels", workflowId: wf.workflow.id }));
    expect(() => asOwner((tx, ctx) => archiveWorkflow(tx, ctx, { workflowId: wf.workflow.id }))).toThrow(/job type/);
    run(ids.users.manager, (tx, ctx) => archiveJobType(tx, ctx, { jobTypeId: jt.id }));

    const archived = asOwner((tx, ctx) => archiveWorkflow(tx, ctx, { workflowId: wf.workflow.id }));
    expect(archived.archivedAt).not.toBeNull();
    expect(() => asOwner((tx, ctx) => addStatus(tx, ctx, { workflowId: wf.workflow.id, name: "X", category: "review" }))).toThrow(/archived/);
  });
});

describe("statuses", () => {
  it("adds a status to an in-use workflow (draft problems reported, not blocking) and keys stay unique", () => {
    const res = asOwner((tx, ctx) => addStatus(tx, ctx, { workflowId: ids.workflowId, name: "In-Progress", category: "in_progress" }));
    expect(res.status.key).toMatch(/^in_progress_2$/);
    expect(res.graph.inUse).toBe(true);
    expect(res.graph.problems.some((p) => p.includes("not reachable"))).toBe(true);
    expect(() => asOwner((tx, ctx) => addStatus(tx, ctx, { workflowId: ids.workflowId, name: "in-progress", category: "review" }))).toThrow(
      /already exists/,
    );
    expect(() => asOwner((tx, ctx) => addStatus(tx, ctx, { workflowId: ids.workflowId, name: "Draft", category: "ready", isInitial: true }))).toThrow(
      /initial/,
    );
  });

  it("archiving is blocked while jobs sit in the status and for the initial status; edges are archived with it", () => {
    insertJobFixture(db, ids, { statusKey: "review" });
    expect(() => asOwner((tx, ctx) => archiveStatus(tx, ctx, { statusId: ids.statuses.review }))).toThrow(/1 job/);
    expect(() => asOwner((tx, ctx) => archiveStatus(tx, ctx, { statusId: ids.statuses.new }))).toThrow(/initial/);

    const res = asOwner((tx, ctx) => archiveStatus(tx, ctx, { statusId: ids.statuses.delivered }));
    expect(res.status.archivedAt).not.toBeNull();
    const deliveredEdges = res.graph.transitions.filter((e) => e.fromStatusId === ids.statuses.delivered || e.toStatusId === ids.statuses.delivered);
    expect(deliveredEdges.length).toBeGreaterThan(0);
    expect(deliveredEdges.every((e) => e.archivedAt !== null)).toBe(true);
    expect(res.graph.problems).toEqual([]);
  });

  it("an in-use workflow cannot lose a required category", () => {
    expect(() => asOwner((tx, ctx) => archiveStatus(tx, ctx, { statusId: ids.statuses.approved }))).toThrow(/in use/);
    // rolled back: still active
    expect(getWorkflowGraph(db, contextFor(db, ids.users.owner), ids.workflowId).statuses.find((s) => s.id === ids.statuses.approved)?.archivedAt).toBeNull();
  });

  it("recategorising a status with jobs rewrites jobs.status_category in the same tx", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "review" });
    const res = asOwner((tx, ctx) => updateStatus(tx, ctx, { statusId: ids.statuses.review, category: "submitted", expectedVersion: 1 }));
    expect(res.affectedJobIds).toEqual([job.id]);
    const after = db.select().from(jobs).where(eq(jobs.id, job.id)).get();
    expect(after).toMatchObject({ statusCategory: "submitted", version: job.version + 1 });
    const ev = db.select().from(activityEvents).where(eq(activityEvents.eventType, "status.updated")).all();
    expect(ev).toHaveLength(1);
    expect(ev[0].previousValue).toEqual({ category: "review" });
    expect(ev[0].metadata).toMatchObject({ affectedJobCount: 1 });
  });

  it("recategorising cannot cross the open/terminal boundary or leave jobs without a required editor", () => {
    insertJobFixture(db, ids, { statusKey: "approved" });
    expect(() => asOwner((tx, ctx) => updateStatus(tx, ctx, { statusId: ids.statuses.approved, category: "completed" }))).toThrow(/open and closed/);
    insertJobFixture(db, ids, { statusKey: "ready", editorId: null });
    expect(() => asOwner((tx, ctx) => updateStatus(tx, ctx, { statusId: ids.statuses.ready, category: "assigned" }))).toThrow(/no editor/);
    expect(() => asOwner((tx, ctx) => updateStatus(tx, ctx, { statusId: ids.statuses.new, category: "ready" }))).toThrow(/initial/);
  });

  it("renames and reorders with events", () => {
    const res = asOwner((tx, ctx) => updateStatus(tx, ctx, { statusId: ids.statuses.review, name: "Client Review" }));
    expect(res.status.name).toBe("Client Review");
    const live = res.graph.statuses.filter((s) => s.archivedAt === null).map((s) => s.id);
    const reversed = [...live].reverse();
    const graph = asOwner((tx, ctx) => reorderStatuses(tx, ctx, { workflowId: ids.workflowId, statusIds: reversed }));
    expect(graph.statuses.filter((s) => s.archivedAt === null).map((s) => s.id)).toEqual(reversed);
    expect(() => asOwner((tx, ctx) => reorderStatuses(tx, ctx, { workflowId: ids.workflowId, statusIds: reversed.slice(1) }))).toThrow(
      ValidationError,
    );
    expect(db.select().from(activityEvents).where(eq(activityEvents.eventType, "status.reordered")).all()).toHaveLength(1);
  });
});

describe("transitions", () => {
  it("adds, updates and revives edges; duplicates are rejected", () => {
    const res = asOwner((tx, ctx) =>
      addTransition(tx, ctx, { workflowId: ids.workflowId, fromStatusId: ids.statuses.new, toStatusId: ids.statuses.in_progress, allowedRoles: ["owner"] }),
    );
    expect(res.transition.allowedRoles).toEqual(["owner"]);
    const ev = db.select().from(activityEvents).where(eq(activityEvents.entityId, res.transition.id)).all();
    expect(ev[0].summary).toContain("New → In Progress");

    expect(() =>
      asOwner((tx, ctx) =>
        addTransition(tx, ctx, { workflowId: ids.workflowId, fromStatusId: ids.statuses.new, toStatusId: ids.statuses.in_progress, allowedRoles: ["owner"] }),
      ),
    ).toThrow(/already exists/);

    const upd = asOwner((tx, ctx) => updateTransition(tx, ctx, { transitionId: res.transition.id, allowedRoles: ["owner", "manager"], label: "Fast track" }));
    expect(upd.transition).toMatchObject({ allowedRoles: ["owner", "manager"], label: "Fast track" });

    asOwner((tx, ctx) => archiveTransition(tx, ctx, { transitionId: res.transition.id }));
    const revived = asOwner((tx, ctx) =>
      addTransition(tx, ctx, { workflowId: ids.workflowId, fromStatusId: ids.statuses.new, toStatusId: ids.statuses.in_progress, allowedRoles: ["manager"] }),
    );
    expect(revived.transition.id).toBe(res.transition.id);
    expect(revived.transition).toMatchObject({ archivedAt: null, allowedRoles: ["manager"] });
  });

  it("validates roles and endpoints", () => {
    expect(() =>
      asOwner((tx, ctx) =>
        addTransition(tx, ctx, { workflowId: ids.workflowId, fromStatusId: ids.statuses.new, toStatusId: ids.statuses.review, allowedRoles: [] }),
      ),
    ).toThrow(ValidationError);
    const other = seedMinimalOrg(db, { slug: "other" });
    expect(() =>
      asOwner((tx, ctx) =>
        addTransition(tx, ctx, { workflowId: ids.workflowId, fromStatusId: ids.statuses.new, toStatusId: other.statuses.review, allowedRoles: ["owner"] }),
      ),
    ).toThrow(NotFoundError);
  });

  it("a status holding jobs cannot lose its last way out", () => {
    insertJobFixture(db, ids, { statusKey: "in_progress" });
    asOwner((tx, ctx) => archiveTransition(tx, ctx, { transitionId: ids.transitions["in_progress->ready"] }));
    expect(() => asOwner((tx, ctx) => archiveTransition(tx, ctx, { transitionId: ids.transitions["in_progress->submitted"] }))).toThrow(/no way out/);
  });
});

describe("job types", () => {
  it("managers manage job types bound to valid workflows; editors cannot", () => {
    const jt = run(ids.users.manager, (tx, ctx) => createJobType(tx, ctx, { name: "Aerial", defaultEstimatedHours: 1.5 }));
    expect(jt.workflowId).toBe(ids.workflowId);
    expect(() => run(ids.users.editor1, (tx, ctx) => createJobType(tx, ctx, { name: "Nope" }))).toThrow(ForbiddenError);
    expect(() => run(ids.users.manager, (tx, ctx) => createJobType(tx, ctx, { name: "aerial" }))).toThrow(/already exists/);

    const blank = asOwner((tx, ctx) => createWorkflow(tx, ctx, { name: "Blank", from: "blank" }));
    expect(() => run(ids.users.manager, (tx, ctx) => updateJobType(tx, ctx, { jobTypeId: jt.id, workflowId: blank.workflow.id }))).toThrow(/problems/);

    const video = asOwner((tx, ctx) => createWorkflow(tx, ctx, { name: "Video" }));
    const moved = run(ids.users.manager, (tx, ctx) => updateJobType(tx, ctx, { jobTypeId: jt.id, workflowId: video.workflow.id, expectedVersion: 1 }));
    expect(moved).toMatchObject({ workflowId: video.workflow.id, version: 2 });
    const ev = db.select().from(activityEvents).where(eq(activityEvents.eventType, "job_type.updated")).all();
    expect(ev[0].metadata).toMatchObject({ fromLabel: "Standard Photography Workflow", toLabel: "Video" });

    run(ids.users.manager, (tx, ctx) => archiveJobType(tx, ctx, { jobTypeId: jt.id }));
    expect(() => run(ids.users.manager, (tx, ctx) => updateJobType(tx, ctx, { jobTypeId: jt.id, name: "X" }))).toThrow(/archived/);
    expect(run(ids.users.manager, (tx, ctx) => restoreJobType(tx, ctx, { jobTypeId: jt.id })).archivedAt).toBeNull();
  });
});
