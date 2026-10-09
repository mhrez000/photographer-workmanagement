/**
 * In-app notifications (ARCHITECTURE.md §6).
 *
 * `notify()` is called by other services inside their transaction. Rules:
 *   - never notifies the actor (ctx.userId)
 *   - skips inactive users and users outside the organisation
 *   - skips users whose user_notification_prefs row disables the type,
 *     unless NOTIFICATION_TYPE_META[type].mandatory
 *   - dedupes per (user, activityEventId, type) and per (user, dedupeKey):
 *     pre-check + INSERT … ON CONFLICT DO NOTHING (the partial unique
 *     indexes make it race-safe)
 *   - when organisation_settings.audit_notifications is on, writes a
 *     `notification.sent` event per inserted row
 *
 * `notifications.read_at` is the only mutable column and is not audited
 * (explicit exemption, §5).
 */
import { and, count, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { getDb, type DbLike, type Tx } from "@/db/index";
import { jobComments, jobs, notifications, userNotificationPrefs, users } from "@/db/schema";
import { MANAGEMENT_ROLES, NOTIFICATION_TYPE_META, type NotificationType } from "@/lib/constants";
import type { AuthContext } from "@/lib/types";
import { assertCan } from "@/server/auth/permissions";
import { recordEvent } from "@/server/audit";
import { NotFoundError } from "@/server/errors";
import { parseInput } from "./_shared";

export interface NotifyInput {
  /** Candidate recipients; null/undefined/duplicates are ignored. */
  userIds: readonly (string | null | undefined)[];
  type: NotificationType;
  title: string;
  body?: string | null;
  jobId?: string | null;
  activityEventId?: string | null;
  /** In-app path, e.g. `/jobs/<id>#revision-2`. */
  linkPath: string;
  /** e.g. `overdue:<jobId>:<dueDate>`; at most one notification per (user, key), ever. */
  dedupeKey?: string | null;
}

export interface NotifyResult {
  /** Ids of the notifications actually inserted. */
  notificationIds: string[];
  /** Users that received one. */
  recipientIds: string[];
}

/** Sends one notification per eligible recipient. See module doc for the rules. */
export function notify(tx: Tx, ctx: AuthContext, input: NotifyInput): NotifyResult {
  const empty: NotifyResult = { notificationIds: [], recipientIds: [] };
  const candidates = Array.from(
    new Set(input.userIds.filter((id): id is string => typeof id === "string" && id.length > 0 && id !== ctx.userId)),
  );
  if (candidates.length === 0) return empty;

  // Active users of this organisation only.
  let eligible = tx
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, candidates), eq(users.organisationId, ctx.organisationId), eq(users.isActive, true)))
    .all()
    .map((r) => r.id);
  if (eligible.length === 0) return empty;

  // Preferences (missing row = enabled; mandatory types ignore prefs).
  if (!NOTIFICATION_TYPE_META[input.type].mandatory) {
    const disabled = new Set(
      tx
        .select({ userId: userNotificationPrefs.userId })
        .from(userNotificationPrefs)
        .where(
          and(
            inArray(userNotificationPrefs.userId, eligible),
            eq(userNotificationPrefs.type, input.type),
            eq(userNotificationPrefs.enabled, false),
          ),
        )
        .all()
        .map((r) => r.userId),
    );
    eligible = eligible.filter((id) => !disabled.has(id));
  }

  // Dedupe pre-check (the unique indexes back this up via ON CONFLICT DO NOTHING).
  const dupeConditions = [];
  if (input.activityEventId) {
    dupeConditions.push(and(eq(notifications.activityEventId, input.activityEventId), eq(notifications.type, input.type)));
  }
  if (input.dedupeKey) dupeConditions.push(eq(notifications.dedupeKey, input.dedupeKey));
  if (dupeConditions.length > 0 && eligible.length > 0) {
    const already = new Set(
      tx
        .select({ userId: notifications.userId })
        .from(notifications)
        .where(and(inArray(notifications.userId, eligible), or(...dupeConditions)))
        .all()
        .map((r) => r.userId),
    );
    eligible = eligible.filter((id) => !already.has(id));
  }
  if (eligible.length === 0) return empty;

  const createdAt = ctx.now();
  const inserted = tx
    .insert(notifications)
    .values(
      eligible.map((userId) => ({
        organisationId: ctx.organisationId,
        userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        jobId: input.jobId ?? null,
        actorUserId: ctx.userId,
        activityEventId: input.activityEventId ?? null,
        linkPath: input.linkPath,
        dedupeKey: input.dedupeKey ?? null,
        createdAt,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: notifications.id, userId: notifications.userId })
    .all();

  if (ctx.settings.auditNotifications) {
    for (const row of inserted) {
      recordEvent(tx, ctx, {
        entityType: "notification",
        entityId: row.id,
        jobId: null,
        eventType: "notification.sent",
        action: "created",
        previousValue: null,
        newValue: { type: input.type, userId: row.userId },
        metadata: { jobId: input.jobId ?? null, activityEventId: input.activityEventId ?? null },
      });
    }
  }

  return { notificationIds: inserted.map((r) => r.id), recipientIds: inserted.map((r) => r.userId) };
}

/* ------------------------------------------------------------------ */
/*  Recipient helpers                                                  */
/* ------------------------------------------------------------------ */

/** Active owners + managers of the organisation. */
export function managersOf(db: DbLike, organisationId: string): string[] {
  return db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.organisationId, organisationId), eq(users.isActive, true), inArray(users.role, [...MANAGEMENT_ROLES])))
    .all()
    .map((r) => r.id);
}

/** Active owners of the organisation. */
export function ownersOf(db: DbLike, organisationId: string): string[] {
  return db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.organisationId, organisationId), eq(users.isActive, true), eq(users.role, "owner")))
    .all()
    .map((r) => r.id);
}

export interface JobParticipants {
  photographerId: string | null;
  editorId: string | null;
  createdByUserId: string;
  /** Distinct authors of non-deleted comments (in `rootCommentId`'s thread when given). */
  commenterIds: string[];
}

/** People attached to a job. Throws NotFoundError for an unknown job id. */
export function jobParticipants(db: DbLike, jobId: string, opts: { rootCommentId?: string } = {}): JobParticipants {
  const job = db
    .select({ photographerId: jobs.photographerId, editorId: jobs.editorId, createdByUserId: jobs.createdByUserId })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .get();
  if (!job) throw new NotFoundError("Job");
  const commenters = db
    .selectDistinct({ userId: jobComments.authorUserId })
    .from(jobComments)
    .where(
      and(
        eq(jobComments.jobId, jobId),
        isNull(jobComments.deletedAt),
        opts.rootCommentId ? eq(jobComments.rootCommentId, opts.rootCommentId) : undefined,
      ),
    )
    .all();
  return { ...job, commenterIds: commenters.map((c) => c.userId) };
}

/* ------------------------------------------------------------------ */
/*  Reader actions (self only)                                         */
/* ------------------------------------------------------------------ */

const MarkReadInput = z.object({ notificationId: z.string().min(1).max(64) });

function requireUserId(ctx: AuthContext): string {
  if (!ctx.userId) throw new NotFoundError("Notification");
  return ctx.userId;
}

/** Marks one of the actor's notifications read. Foreign/other-user ids → 404. Idempotent. */
export function markRead(tx: Tx, ctx: AuthContext, input: unknown): { id: string; readAt: string } {
  const userId = requireUserId(ctx);
  assertCan(ctx, "notification.read", { userId, organisationId: ctx.organisationId });
  const { notificationId } = parseInput(MarkReadInput, input);
  const row = tx
    .select({ id: notifications.id, readAt: notifications.readAt })
    .from(notifications)
    .where(
      and(eq(notifications.id, notificationId), eq(notifications.userId, userId), eq(notifications.organisationId, ctx.organisationId)),
    )
    .get();
  if (!row) throw new NotFoundError("Notification");
  if (row.readAt) return { id: row.id, readAt: row.readAt };
  const readAt = ctx.now();
  tx.update(notifications).set({ readAt }).where(and(eq(notifications.id, row.id), isNull(notifications.readAt))).run();
  return { id: row.id, readAt };
}

/** Marks every unread notification of the actor read; returns how many changed. */
export function markAllRead(tx: Tx, ctx: AuthContext): { updated: number } {
  const userId = requireUserId(ctx);
  assertCan(ctx, "notification.read", { userId, organisationId: ctx.organisationId });
  const result = tx
    .update(notifications)
    .set({ readAt: ctx.now() })
    .where(and(eq(notifications.userId, userId), eq(notifications.organisationId, ctx.organisationId), isNull(notifications.readAt)))
    .run();
  return { updated: result.changes };
}

/** Unread badge count for the actor (0 for the system context). */
export function unreadCount(ctx: AuthContext, db: DbLike = getDb()): number {
  if (!ctx.userId) return 0;
  const row = db
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, ctx.userId), eq(notifications.organisationId, ctx.organisationId), isNull(notifications.readAt)))
    .get();
  return row?.n ?? 0;
}
