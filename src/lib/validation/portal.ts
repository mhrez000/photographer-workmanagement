/**
 * Zod schemas for the client portal API (docs/ROLES.md §7.5, §7.7).
 * Strict objects: a client can never smuggle staff fields (kind, mentions,
 * revision ids, sharing flags) through a portal route.
 */
import { z } from "zod";
import { CLIENT_NOTIFICATION_TYPES } from "@/lib/constants";
import { PORTAL_SORTS } from "@/lib/portal";
import { CommentBodySchema } from "./comments";

const Id = z.string().trim().min(1).max(64);

/** POST /api/portal/jobs/:id/feedback — a new thread, or a reply inside one of the client's threads. */
export const PortalFeedbackInput = z.strictObject({
  jobId: Id,
  body: CommentBodySchema,
  parentCommentId: Id.nullish(),
});
export type PortalFeedbackInput = z.input<typeof PortalFeedbackInput>;

/** PATCH /api/portal/comments/:id */
export const PortalFeedbackEditInput = z.strictObject({
  commentId: Id,
  body: CommentBodySchema,
});
export type PortalFeedbackEditInput = z.input<typeof PortalFeedbackEditInput>;

/** DELETE /api/portal/comments/:id */
export const PortalFeedbackDeleteInput = z.strictObject({ commentId: Id });
export type PortalFeedbackDeleteInput = z.input<typeof PortalFeedbackDeleteInput>;

/** PATCH /api/portal/me — the portal account's display name (nothing else). */
export const PortalProfileInput = z.strictObject({
  name: z.string({ error: "Enter your name" }).trim().min(1, "Enter your name").max(120, "Keep your name under 120 characters"),
  expectedVersion: z.number().int().min(0).optional(),
});
export type PortalProfileInput = z.input<typeof PortalProfileInput>;

/** PUT /api/portal/notification-prefs — only the three client notification types. */
export const PortalNotificationPrefsInput = z.strictObject({
  prefs: z.partialRecord(z.enum(CLIENT_NOTIFICATION_TYPES), z.boolean()),
});
export type PortalNotificationPrefsInput = z.input<typeof PortalNotificationPrefsInput>;

const firstOf = <T extends z.ZodType>(item: T) => z.preprocess((v) => (Array.isArray(v) ? v[0] : v === "" ? undefined : v), item);

/** GET /api/portal/jobs?sort=progress|delivered */
export const PortalJobsQuery = z.object({
  sort: firstOf(z.enum(PORTAL_SORTS).optional()),
});
export type PortalJobsQuery = z.input<typeof PortalJobsQuery>;
