/**
 * TEST-ONLY history builders for the read-side query tests. They write
 * multi-step ledger history directly (the workflow/assignment services are
 * not required) in the order the guards demand: close the open transition →
 * insert the next transition row → update `jobs`. No activity events are
 * written except where a test needs one. Never imported by app code.
 */
import { and, eq, isNull } from "drizzle-orm";
import { first, one, type Db } from "@/db/index";
import { activityEvents, jobAssignments, jobRevisions, jobStatusTransitions, jobs, workflowStatuses } from "@/db/schema";
import type { SeedIds } from "@/db/test-db";
import { durationSeconds } from "@/lib/metrics";
import type { NewJob } from "@/lib/types";

export interface MoveOptions {
  isReopen?: boolean;
  /** Extra jobs columns to set with the status change. */
  patch?: Partial<NewJob>;
  actorUserId?: string | null;
}

/** Moves `jobId` to the default-workflow status `toKey` at instant `at`, with §4.4 milestone columns. */
export async function moveJob(db: Db, ids: SeedIds, jobId: string, toKey: string, at: string, opts: MoveOptions = {}): Promise<void> {
  await db.transaction(async (tx) => {
    const job = await first(tx.select().from(jobs).where(eq(jobs.id, jobId)));
    if (!job) throw new Error(`moveJob: job ${jobId} missing`);
    const status = await first(tx.select().from(workflowStatuses).where(eq(workflowStatuses.id, ids.statuses[toKey])));
    if (!status) throw new Error(`moveJob: status ${toKey} missing`);
    const open = await first(
      tx
        .select()
        .from(jobStatusTransitions)
        .where(and(eq(jobStatusTransitions.jobId, jobId), isNull(jobStatusTransitions.exitedAt))),
    );
    if (!open) throw new Error("moveJob: no open transition");
    await tx
      .update(jobStatusTransitions)
      .set({
        exitedAt: at,
        durationSeconds: durationSeconds(open.enteredAt, at, at),
      })
      .where(eq(jobStatusTransitions.id, open.id));
    await tx.insert(jobStatusTransitions).values({
      organisationId: job.organisationId,
      jobId,
      sequence: open.sequence + 1,
      kind: "transition",
      fromStatusId: open.toStatusId,
      toStatusId: status.id,
      fromCategory: open.toCategory,
      toCategory: status.category,
      statusName: status.name,
      actorUserId: opts.actorUserId === undefined ? ids.users.manager : opts.actorUserId,
      isReopen: opts.isReopen ?? false,
      enteredAt: at,
      editorIdAtEntry: job.editorId,
      photographerIdAtEntry: job.photographerId,
    });
    const c = status.category;
    const milestones: Partial<NewJob> = {};
    if (c === "in_progress" && !job.startedAt) milestones.startedAt = at;
    if (c === "submitted" || c === "resubmitted") {
      milestones.firstSubmittedAt = job.firstSubmittedAt ?? at;
      milestones.lastSubmittedAt = at;
    }
    if (c === "approved") {
      milestones.approvedAt = at;
      milestones.approvedByUserId = ids.users.manager;
      milestones.dueDateAtApproval = job.dueDate;
      milestones.wasOnTime = job.dueDate === null ? null : at <= job.dueDate;
      milestones.completionPercent = 100;
    }
    if (c === "delivered") milestones.deliveredAt = at;
    if (c === "completed") {
      milestones.completedAt = at;
      milestones.dueDateAtCompletion = job.dueDate;
    }
    if (c === "cancelled") milestones.cancelledAt = at;
    if (opts.isReopen) {
      milestones.completedAt = null;
      milestones.approvedAt = null;
      milestones.deliveredAt = null;
      milestones.reopenedCount = job.reopenedCount + 1;
    }
    await tx
      .update(jobs)
      .set({
        statusId: status.id,
        statusCategory: c,
        previousStatusId: open.toStatusId,
        statusEnteredAt: at,
        isPaused: false,
        pausedAt: null,
        lastActivityAt: at > job.lastActivityAt ? at : job.lastActivityAt,
        updatedAt: at,
        version: job.version + 1,
        ...milestones,
        ...opts.patch,
      })
      .where(eq(jobs.id, jobId));
  });
}

/** Reassigns the editor mid-stage: closes/open assignments and writes a `reattribution` transition row. */
export async function reattribute(db: Db, ids: SeedIds, jobId: string, newEditorId: string, at: string): Promise<void> {
  await db.transaction(async (tx) => {
    const job = await first(tx.select().from(jobs).where(eq(jobs.id, jobId)));
    if (!job) throw new Error("reattribute: job missing");
    await tx
      .update(jobAssignments)
      .set({
        unassignedAt: at,
        unassignedByUserId: ids.users.manager,
        unassignReason: "reassigned",
      })
      .where(and(eq(jobAssignments.jobId, jobId), eq(jobAssignments.role, "editor"), isNull(jobAssignments.unassignedAt)));
    await tx.insert(jobAssignments).values({
      organisationId: job.organisationId,
      jobId,
      role: "editor",
      userId: newEditorId,
      assignedByUserId: ids.users.manager,
      assignedAt: at,
      statusCategoryAtAssign: job.statusCategory,
    });
    const open = await first(
      tx
        .select()
        .from(jobStatusTransitions)
        .where(and(eq(jobStatusTransitions.jobId, jobId), isNull(jobStatusTransitions.exitedAt))),
    );
    if (!open) throw new Error("reattribute: no open transition");
    await tx
      .update(jobStatusTransitions)
      .set({
        exitedAt: at,
        durationSeconds: durationSeconds(open.enteredAt, at, at),
      })
      .where(eq(jobStatusTransitions.id, open.id));
    await tx.insert(jobStatusTransitions).values({
      organisationId: job.organisationId,
      jobId,
      sequence: open.sequence + 1,
      kind: "reattribution",
      fromStatusId: open.toStatusId,
      toStatusId: open.toStatusId,
      fromCategory: open.toCategory,
      toCategory: open.toCategory,
      statusName: open.statusName,
      actorUserId: ids.users.manager,
      reason: "reassigned",
      enteredAt: at,
      editorIdAtEntry: newEditorId,
      photographerIdAtEntry: job.photographerId,
    });
    await tx
      .update(jobs)
      .set({
        editorId: newEditorId,
        previousEditorId: job.editorId,
        updatedAt: at,
        version: job.version + 1,
      })
      .where(eq(jobs.id, jobId));
  });
}

/** A resolved revision row (#n) requested at `at`; bumps jobs.revision_count to n. */
export async function addRevision(db: Db, ids: SeedIds, jobId: string, n: number, at: string): Promise<string> {
  return db.transaction(async (tx) => {
    const row = await one(
      tx
        .insert(jobRevisions)
        .values({
          organisationId: ids.organisationId,
          jobId,
          revisionNumber: n,
          requestedByUserId: ids.users.manager,
          assigneeUserId: ids.users.editor1,
          reason: "Colour",
          description: "Fix colour",
          requestedAt: at,
          resolvedAt: at,
          resolvedByUserId: ids.users.editor1,
          resolution: "resubmitted",
        })
        .returning({ id: jobRevisions.id }),
    );
    await tx.update(jobs).set({ revisionCount: n }).where(eq(jobs.id, jobId));
    return row.id;
  });
}

/** Sets jobs.last_activity_at directly (stalled-rule tests). */
export async function setLastActivity(db: Db, jobId: string, at: string): Promise<void> {
  await db.update(jobs).set({ lastActivityAt: at }).where(eq(jobs.id, jobId));
}

/** Count of activity events for a job (sanity checks). */
export async function eventCount(db: Db, jobId: string): Promise<number> {
  return (await db.select({ id: activityEvents.id }).from(activityEvents).where(eq(activityEvents.jobId, jobId))).length;
}
