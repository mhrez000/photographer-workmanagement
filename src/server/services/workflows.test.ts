import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first, type Tx } from "@/db/index";
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

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

async function run<T>(userId: string, fn: (tx: Tx, ctx: AuthContext) => Promise<T> | T): Promise<T> {
  const ctx = await contextFor(db, userId);
  return withTx((tx) => fn(tx, ctx), { db });
}
const asOwner = <T>(fn: (tx: Tx, ctx: AuthContext) => Promise<T> | T) => run(ids.users.owner, fn);

describe("workflow permissions", () => {
  it("view and manage = admins only (a team member with every switch and photographers get 403)", async () => {
    // v1 managers could view but not manage; v2 has no manager role. The nearest v2 rules (docs/ROLES.md §3.3
    // workflow.view / workflow.manage = admin only): a co-admin views AND manages; `lead` (= a migrated manager,
    // every member switch on) and other photographers are refused both.
    expect((await getWorkflowGraph(db, await contextFor(db, ids.users.coAdmin), ids.workflowId)).problems).toEqual([]);
    await expect(getWorkflowGraph(db, await contextFor(db, ids.users.lead), ids.workflowId)).rejects.toThrow(ForbiddenError);
    await expect(getWorkflowGraph(db, await contextFor(db, ids.users.photographer1), ids.workflowId)).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.lead, (tx, ctx) => createWorkflow(tx, ctx, { name: "X" }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.lead, (tx, ctx) => addStatus(tx, ctx, { workflowId: ids.workflowId, name: "Hold", category: "review" }))).rejects.toThrow(
      ForbiddenError,
    );
    expect((await run(ids.users.coAdmin, (tx, ctx) => createWorkflow(tx, ctx, { name: "X" }))).problems).toEqual([]);
  });

  it("foreign workflows are 404", async () => {
    const other = await seedMinimalOrg(db, { slug: "other" });
    await expect(getWorkflowGraph(db, await contextFor(db, ids.users.owner), other.workflowId)).rejects.toThrow(NotFoundError);
    await expect(asOwner((tx, ctx) => addStatus(tx, ctx, { workflowId: other.workflowId, name: "X", category: "review" }))).rejects.toThrow(NotFoundError);
  });
});

describe("createWorkflow / updateWorkflow / archiveWorkflow", () => {
  it("default template is valid and audited; blank needs work; copy mirrors the source", async () => {
    const def = await asOwner((tx, ctx) => createWorkflow(tx, ctx, { name: "Quick Turnaround", from: "default" }));
    expect(def.problems).toEqual([]);
    expect(def.statuses).toHaveLength(13);
    expect(def.inUse).toBe(false);
    const ev = await db.select().from(activityEvents).where(eq(activityEvents.entityId, def.workflow.id)).orderBy(activityEvents.rowid);
    expect(ev[0]).toMatchObject({ eventType: "workflow.created", visibility: "management" });

    const blank = await asOwner((tx, ctx) => createWorkflow(tx, ctx, { name: "Blank", from: "blank" }));
    expect(blank.statuses.map((s) => s.category).sort()).toEqual(["approved", "cancelled", "completed", "in_progress", "new", "submitted"]);
    expect(blank.problems.length).toBeGreaterThan(0);
    expect(await validateWorkflow(db, await contextFor(db, ids.users.owner), blank.workflow.id)).toEqual(blank.problems);

    const copy = await asOwner((tx, ctx) => createWorkflow(tx, ctx, { name: "Copy", from: "workflow", sourceWorkflowId: ids.workflowId }));
    expect(copy.statuses.map((s) => s.key)).toEqual(
      (await getWorkflowGraph(db, await contextFor(db, ids.users.owner), ids.workflowId)).statuses.map((s) => s.key),
    );
    expect(copy.transitions).toHaveLength((await db.select().from(workflowTransitions).where(eq(workflowTransitions.workflowId, ids.workflowId))).length);
    expect(copy.problems).toEqual([]);

    await expect(asOwner((tx, ctx) => createWorkflow(tx, ctx, { name: "copy" }))).rejects.toThrow(/already exists/);
  });

  it("only a valid workflow can become the default; the previous default is unset", async () => {
    const blank = await asOwner((tx, ctx) => createWorkflow(tx, ctx, { name: "Blank", from: "blank" }));
    await expect(asOwner((tx, ctx) => updateWorkflow(tx, ctx, { workflowId: blank.workflow.id, isDefault: true }))).rejects.toThrow(/problems/);

    const next = await asOwner((tx, ctx) => createWorkflow(tx, ctx, { name: "Next", isDefault: true }));
    expect(next.workflow.isDefault).toBe(true);
    expect((await first(db.select().from(workflows).where(eq(workflows.id, ids.workflowId))))?.isDefault).toBe(false);
    const renamed = await asOwner((tx, ctx) => updateWorkflow(tx, ctx, { workflowId: next.workflow.id, name: "Standard v2" }));
    expect(renamed.workflow.name).toBe("Standard v2");
  });

  it("archive is blocked for the default, for bound job types and for active jobs", async () => {
    await expect(asOwner((tx, ctx) => archiveWorkflow(tx, ctx, { workflowId: ids.workflowId }))).rejects.toThrow(/default/);

    const wf = await asOwner((tx, ctx) => createWorkflow(tx, ctx, { name: "Video" }));
    const jt = await run(ids.users.coAdmin, (tx, ctx) => createJobType(tx, ctx, { name: "Reels", workflowId: wf.workflow.id }));
    await expect(asOwner((tx, ctx) => archiveWorkflow(tx, ctx, { workflowId: wf.workflow.id }))).rejects.toThrow(/job type/);
    await run(ids.users.coAdmin, (tx, ctx) => archiveJobType(tx, ctx, { jobTypeId: jt.id }));

    const archived = await asOwner((tx, ctx) => archiveWorkflow(tx, ctx, { workflowId: wf.workflow.id }));
    expect(archived.archivedAt).not.toBeNull();
    await expect(asOwner((tx, ctx) => addStatus(tx, ctx, { workflowId: wf.workflow.id, name: "X", category: "review" }))).rejects.toThrow(/archived/);
  });
});

describe("statuses", () => {
  it("adds a status to an in-use workflow (draft problems reported, not blocking) and keys stay unique", async () => {
    const res = await asOwner((tx, ctx) => addStatus(tx, ctx, { workflowId: ids.workflowId, name: "In-Progress", category: "in_progress" }));
    expect(res.status.key).toMatch(/^in_progress_2$/);
    expect(res.graph.inUse).toBe(true);
    expect(res.graph.problems.some((p) => p.includes("not reachable"))).toBe(true);
    await expect(asOwner((tx, ctx) => addStatus(tx, ctx, { workflowId: ids.workflowId, name: "in-progress", category: "review" }))).rejects.toThrow(
      /already exists/,
    );
    await expect(asOwner((tx, ctx) => addStatus(tx, ctx, { workflowId: ids.workflowId, name: "Draft", category: "ready", isInitial: true }))).rejects.toThrow(
      /initial/,
    );
  });

  it("archiving is blocked while jobs sit in the status and for the initial status; edges are archived with it", async () => {
    await insertJobFixture(db, ids, { statusKey: "review" });
    await expect(asOwner((tx, ctx) => archiveStatus(tx, ctx, { statusId: ids.statuses.review }))).rejects.toThrow(/1 job/);
    await expect(asOwner((tx, ctx) => archiveStatus(tx, ctx, { statusId: ids.statuses.new }))).rejects.toThrow(/initial/);

    const res = await asOwner((tx, ctx) => archiveStatus(tx, ctx, { statusId: ids.statuses.delivered }));
    expect(res.status.archivedAt).not.toBeNull();
    const deliveredEdges = res.graph.transitions.filter((e) => e.fromStatusId === ids.statuses.delivered || e.toStatusId === ids.statuses.delivered);
    expect(deliveredEdges.length).toBeGreaterThan(0);
    expect(deliveredEdges.every((e) => e.archivedAt !== null)).toBe(true);
    expect(res.graph.problems).toEqual([]);
  });

  it("an in-use workflow cannot lose a required category", async () => {
    await expect(asOwner((tx, ctx) => archiveStatus(tx, ctx, { statusId: ids.statuses.approved }))).rejects.toThrow(/in use/);
    // rolled back: still active
    expect(
      (await getWorkflowGraph(db, await contextFor(db, ids.users.owner), ids.workflowId)).statuses.find((s) => s.id === ids.statuses.approved)?.archivedAt,
    ).toBeNull();
  });

  it("recategorising a status with jobs rewrites jobs.status_category in the same tx", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "review" });
    const res = await asOwner((tx, ctx) => updateStatus(tx, ctx, { statusId: ids.statuses.review, category: "submitted", expectedVersion: 1 }));
    expect(res.affectedJobIds).toEqual([job.id]);
    const after = await first(db.select().from(jobs).where(eq(jobs.id, job.id)));
    expect(after).toMatchObject({ statusCategory: "submitted", version: job.version + 1 });
    const ev = await db.select().from(activityEvents).where(eq(activityEvents.eventType, "status.updated")).orderBy(activityEvents.rowid);
    expect(ev).toHaveLength(1);
    expect(ev[0].previousValue).toEqual({ category: "review" });
    expect(ev[0].metadata).toMatchObject({ affectedJobCount: 1 });
  });

  it("recategorising cannot cross the open/terminal boundary or leave jobs without a required editor", async () => {
    await insertJobFixture(db, ids, { statusKey: "approved" });
    await expect(asOwner((tx, ctx) => updateStatus(tx, ctx, { statusId: ids.statuses.approved, category: "completed" }))).rejects.toThrow(/open and closed/);
    await insertJobFixture(db, ids, { statusKey: "ready", editorId: null });
    await expect(asOwner((tx, ctx) => updateStatus(tx, ctx, { statusId: ids.statuses.ready, category: "assigned" }))).rejects.toThrow(/no editor/);
    await expect(asOwner((tx, ctx) => updateStatus(tx, ctx, { statusId: ids.statuses.new, category: "ready" }))).rejects.toThrow(/initial/);
  });

  it("renames and reorders with events", async () => {
    const res = await asOwner((tx, ctx) => updateStatus(tx, ctx, { statusId: ids.statuses.review, name: "Client Review" }));
    expect(res.status.name).toBe("Client Review");
    const live = res.graph.statuses.filter((s) => s.archivedAt === null).map((s) => s.id);
    const reversed = [...live].reverse();
    const graph = await asOwner((tx, ctx) => reorderStatuses(tx, ctx, { workflowId: ids.workflowId, statusIds: reversed }));
    expect(graph.statuses.filter((s) => s.archivedAt === null).map((s) => s.id)).toEqual(reversed);
    await expect(asOwner((tx, ctx) => reorderStatuses(tx, ctx, { workflowId: ids.workflowId, statusIds: reversed.slice(1) }))).rejects.toThrow(ValidationError);
    expect(await db.select().from(activityEvents).where(eq(activityEvents.eventType, "status.reordered")).orderBy(activityEvents.rowid)).toHaveLength(1);
  });
});

describe("transitions", () => {
  it("adds, updates and revives edges; duplicates are rejected", async () => {
    const res = await asOwner((tx, ctx) =>
      addTransition(tx, ctx, { workflowId: ids.workflowId, fromStatusId: ids.statuses.new, toStatusId: ids.statuses.in_progress, allowedRoles: ["admin"] }),
    );
    expect(res.transition.allowedRoles).toEqual(["admin"]);
    const ev = await db.select().from(activityEvents).where(eq(activityEvents.entityId, res.transition.id)).orderBy(activityEvents.rowid);
    expect(ev[0].summary).toContain("New → In Progress");

    await expect(
      asOwner((tx, ctx) =>
        addTransition(tx, ctx, { workflowId: ids.workflowId, fromStatusId: ids.statuses.new, toStatusId: ids.statuses.in_progress, allowedRoles: ["admin"] }),
      ),
    ).rejects.toThrow(/already exists/);

    const upd = await asOwner((tx, ctx) =>
      updateTransition(tx, ctx, { transitionId: res.transition.id, allowedRoles: ["admin", "editor"], label: "Fast track" }),
    );
    expect(upd.transition).toMatchObject({ allowedRoles: ["admin", "editor"], label: "Fast track" });

    await asOwner((tx, ctx) => archiveTransition(tx, ctx, { transitionId: res.transition.id }));
    const revived = await asOwner((tx, ctx) =>
      addTransition(tx, ctx, { workflowId: ids.workflowId, fromStatusId: ids.statuses.new, toStatusId: ids.statuses.in_progress, allowedRoles: ["photographer"] }),
    );
    expect(revived.transition.id).toBe(res.transition.id);
    expect(revived.transition).toMatchObject({ archivedAt: null, allowedRoles: ["photographer"] });
  });

  it("validates roles and endpoints", async () => {
    await expect(
      asOwner((tx, ctx) =>
        addTransition(tx, ctx, { workflowId: ids.workflowId, fromStatusId: ids.statuses.new, toStatusId: ids.statuses.review, allowedRoles: [] }),
      ),
    ).rejects.toThrow(ValidationError);
    // v1 role names and `client` are not transition roles any more (docs/ROLES.md §5.1).
    for (const legacy of [["owner"], ["manager"], ["client"]]) {
      await expect(
        asOwner((tx, ctx) =>
          addTransition(tx, ctx, {
            workflowId: ids.workflowId,
            fromStatusId: ids.statuses.new,
            toStatusId: ids.statuses.review,
            allowedRoles: legacy as unknown as ["admin"],
          }),
        ),
      ).rejects.toThrow(ValidationError);
    }
    const other = await seedMinimalOrg(db, { slug: "other" });
    await expect(
      asOwner((tx, ctx) =>
        addTransition(tx, ctx, { workflowId: ids.workflowId, fromStatusId: ids.statuses.new, toStatusId: other.statuses.review, allowedRoles: ["admin"] }),
      ),
    ).rejects.toThrow(NotFoundError);
  });

  it("a status holding jobs cannot lose its last way out", async () => {
    await insertJobFixture(db, ids, { statusKey: "in_progress" });
    await asOwner((tx, ctx) => archiveTransition(tx, ctx, { transitionId: ids.transitions["in_progress->ready"] }));
    await expect(asOwner((tx, ctx) => archiveTransition(tx, ctx, { transitionId: ids.transitions["in_progress->submitted"] }))).rejects.toThrow(/no way out/);
  });
});

describe("job types", () => {
  it("admins manage job types bound to valid workflows; editors and team members cannot", async () => {
    const jt = await run(ids.users.coAdmin, (tx, ctx) => createJobType(tx, ctx, { name: "Aerial", defaultEstimatedHours: 1.5 }));
    expect(jt.workflowId).toBe(ids.workflowId);
    await expect(run(ids.users.editor1, (tx, ctx) => createJobType(tx, ctx, { name: "Nope" }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.lead, (tx, ctx) => createJobType(tx, ctx, { name: "Nope" }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.coAdmin, (tx, ctx) => createJobType(tx, ctx, { name: "aerial" }))).rejects.toThrow(/already exists/);

    const blank = await asOwner((tx, ctx) => createWorkflow(tx, ctx, { name: "Blank", from: "blank" }));
    await expect(run(ids.users.coAdmin, (tx, ctx) => updateJobType(tx, ctx, { jobTypeId: jt.id, workflowId: blank.workflow.id }))).rejects.toThrow(/problems/);

    const video = await asOwner((tx, ctx) => createWorkflow(tx, ctx, { name: "Video" }));
    const moved = await run(ids.users.coAdmin, (tx, ctx) => updateJobType(tx, ctx, { jobTypeId: jt.id, workflowId: video.workflow.id, expectedVersion: 1 }));
    expect(moved).toMatchObject({ workflowId: video.workflow.id, version: 2 });
    const ev = await db.select().from(activityEvents).where(eq(activityEvents.eventType, "job_type.updated")).orderBy(activityEvents.rowid);
    expect(ev[0].metadata).toMatchObject({ fromLabel: "Standard Photography Workflow", toLabel: "Video" });

    await run(ids.users.coAdmin, (tx, ctx) => archiveJobType(tx, ctx, { jobTypeId: jt.id }));
    await expect(run(ids.users.coAdmin, (tx, ctx) => updateJobType(tx, ctx, { jobTypeId: jt.id, name: "X" }))).rejects.toThrow(/archived/);
    expect((await run(ids.users.coAdmin, (tx, ctx) => restoreJobType(tx, ctx, { jobTypeId: jt.id }))).archivedAt).toBeNull();
  });
});
