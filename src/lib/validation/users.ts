/** Zod inputs for the users service (ARCHITECTURE.md §2.1, §3.2, §4.5). */
import { z } from "zod";
import { NOTIFICATION_TYPES, ROLES } from "@/lib/constants";
import { EmailSchema } from "./auth";
import { ExpectedVersionSchema, HexColourSchema, IdSchema, NameSchema, OptionalTextSchema } from "./admin-shared";

const CapacitySchema = z.number().min(0).max(168).nullable();

export const InviteUserInput = z.object({
  email: EmailSchema,
  name: NameSchema(120),
  role: z.enum(ROLES),
  title: OptionalTextSchema(120),
  avatarColour: HexColourSchema.optional(),
  /** null / omitted → organisation default. */
  capacityHoursPerWeek: CapacitySchema.optional(),
  canViewTeamWorkloads: z.boolean().optional(),
  canViewAnalytics: z.boolean().optional(),
});
export type InviteUserInput = z.infer<typeof InviteUserInput>;

/** Profile fields. Self edits may change name/title/avatarColour; email needs `user.edit`. */
export const UpdateUserInput = z.object({
  userId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  name: NameSchema(120).optional(),
  title: OptionalTextSchema(120),
  avatarColour: HexColourSchema.optional(),
  email: EmailSchema.optional(),
});
export type UpdateUserInput = z.infer<typeof UpdateUserInput>;

export const ChangeRoleInput = z.object({
  userId: IdSchema,
  role: z.enum(ROLES),
  expectedVersion: ExpectedVersionSchema,
});
export type ChangeRoleInput = z.infer<typeof ChangeRoleInput>;

export const DeactivateUserInput = z
  .object({
    userId: IdSchema,
    /** Active editor who takes over the user's open editor jobs. */
    reassignTo: IdSchema.nullish(),
    /** Unassign the user's open editor jobs (they go back to Ready). */
    unassign: z.boolean().optional(),
    reason: OptionalTextSchema(500),
    expectedVersion: ExpectedVersionSchema,
  })
  .refine((v) => !(v.reassignTo && v.unassign), { path: ["unassign"], message: "Choose either reassign or unassign, not both" });
export type DeactivateUserInput = z.infer<typeof DeactivateUserInput>;

export const UserIdInput = z.object({ userId: IdSchema, expectedVersion: ExpectedVersionSchema });
export type UserIdInput = z.infer<typeof UserIdInput>;

export const SetCapacityInput = z.object({
  userId: IdSchema,
  capacityHoursPerWeek: CapacitySchema,
  expectedVersion: ExpectedVersionSchema,
});
export type SetCapacityInput = z.infer<typeof SetCapacityInput>;

export const SetVisibilityFlagsInput = z
  .object({
    userId: IdSchema,
    canViewTeamWorkloads: z.boolean().optional(),
    canViewAnalytics: z.boolean().optional(),
    expectedVersion: ExpectedVersionSchema,
  })
  .refine((v) => v.canViewTeamWorkloads !== undefined || v.canViewAnalytics !== undefined, {
    message: "Nothing to change",
  });
export type SetVisibilityFlagsInput = z.infer<typeof SetVisibilityFlagsInput>;

export const SetNotificationPrefsInput = z.object({
  /** Omitted → the actor. Only your own preferences can be changed. */
  userId: IdSchema.optional(),
  prefs: z.partialRecord(z.enum(NOTIFICATION_TYPES), z.boolean()),
});
export type SetNotificationPrefsInput = z.infer<typeof SetNotificationPrefsInput>;
