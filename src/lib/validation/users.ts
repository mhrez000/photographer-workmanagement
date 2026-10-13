/**
 * Zod inputs for the users service (docs/ROLES.md §3.5, §6.1; ARCHITECTURE.md §4.5).
 *
 * The profile schema and every roles-v2 schema are STRICT (`z.strictObject`):
 * unknown keys — including the columns only dedicated services may write
 * (`isAdmin`, `clientId`, the permission switches) — are a 400 (§3.5). The
 * lifecycle schemas (deactivate, capacity, id-only, prefs) keep stripping
 * unknown keys as before.
 */
import { z } from "zod";
import { NOTIFICATION_TYPES, PHOTOGRAPHER_PRESETS, ROLES } from "@/lib/constants";
import { EmailSchema } from "./auth";
import { ExpectedVersionSchema, HexColourSchema, IdSchema, NameSchema, OptionalTextSchema } from "./admin-shared";

const CapacitySchema = z.number().min(0).max(168).nullable();
/** Editors: "Usually handles up to N" jobs on their desk (SIMPLIFICATION-PLAN §7); null = not set. */
export const UsualCapacitySchema = z.number().int().min(1).max(500).nullable();

/** POST /api/users/:id/usual-capacity { usualCapacityJobs, expectedVersion } (editors only; admin). */
export const SetUsualCapacityInput = z.strictObject({
  userId: IdSchema,
  usualCapacityJobs: UsualCapacitySchema,
  expectedVersion: ExpectedVersionSchema,
});
export type SetUsualCapacityInput = z.infer<typeof SetUsualCapacityInput>;

/** Team-member switches an invite may set (omitted → invite defaults, §2.2: review ✗). */
export const MemberFlagsInput = z.strictObject({
  canCreateJobs: z.boolean().optional(),
  canAssignEditors: z.boolean().optional(),
  canReviewSubmissions: z.boolean().optional(),
  canViewTeamWorkloads: z.boolean().optional(),
  canViewAllJobs: z.boolean().optional(),
  canViewAnalytics: z.boolean().optional(),
});
export type MemberFlagsInput = z.infer<typeof MemberFlagsInput>;

/** Editor switches an invite may set (omitted → invite defaults: create ✓, other editors' jobs ✗). */
export const EditorFlagsInput = z.strictObject({
  canCreateJobs: z.boolean().optional(),
  canViewTeamJobs: z.boolean().optional(),
});
export type EditorFlagsInput = z.infer<typeof EditorFlagsInput>;

const inviteBase = {
  email: EmailSchema,
  name: NameSchema(120),
  avatarColour: HexColourSchema.optional(),
};

/**
 * POST /api/users — discriminated on `role` (§6.1):
 * - photographer: optional `isAdmin` (co-owner) and member `flags`, or — the simplified invite
 *   (SIMPLIFICATION-PLAN §2) — one `preset`: "own_shoots" | "co_owner" (explicit `isAdmin` / `flags`
 *   override the preset's values);
 * - editor: optional editor `flags` and the simple "Usually handles up to N" (`usualCapacityJobs`);
 * - client: REQUIRED `clientId` (a non-archived, portal-enabled client of the
 *   organisation); no flags, no capacity, no admin, no title.
 */
export const InviteUserInput = z.discriminatedUnion("role", [
  z.strictObject({
    ...inviteBase,
    role: z.literal("photographer"),
    title: OptionalTextSchema(120),
    /** null / omitted → organisation default. */
    capacityHoursPerWeek: CapacitySchema.optional(),
    isAdmin: z.boolean().optional(),
    flags: MemberFlagsInput.optional(),
    preset: z.enum(PHOTOGRAPHER_PRESETS).optional(),
  }),
  z.strictObject({
    ...inviteBase,
    role: z.literal("editor"),
    title: OptionalTextSchema(120),
    capacityHoursPerWeek: CapacitySchema.optional(),
    usualCapacityJobs: UsualCapacitySchema.optional(),
    flags: EditorFlagsInput.optional(),
  }),
  z.strictObject({
    ...inviteBase,
    role: z.literal("client"),
    clientId: IdSchema,
  }),
]);
export type InviteUserInput = z.infer<typeof InviteUserInput>;

/**
 * Profile fields. Self edits may change name/title/avatarColour (clients: name
 * only); email needs `user.change_email`. Strict: `role`, `isAdmin`, `clientId`
 * and the switches have their own endpoints.
 */
export const UpdateUserInput = z.strictObject({
  userId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  name: NameSchema(120).optional(),
  title: OptionalTextSchema(120),
  avatarColour: HexColourSchema.optional(),
  email: EmailSchema.optional(),
});
export type UpdateUserInput = z.infer<typeof UpdateUserInput>;

/**
 * `role` accepts every stored role so a client ⇄ staff request gets the
 * service's 422 `role_change_not_allowed` rather than a schema error.
 */
export const ChangeRoleInput = z.strictObject({
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

/** POST /api/users/:id/admin { isAdmin, expectedVersion } (§6.1). */
export const SetAdminInput = z.strictObject({
  userId: IdSchema,
  isAdmin: z.boolean(),
  expectedVersion: ExpectedVersionSchema,
});
export type SetAdminInput = z.infer<typeof SetAdminInput>;

/**
 * POST /api/users/:id/permissions (§6.1; replaces /visibility). Member switches
 * apply to non-admin photographers, `canViewTeamJobs` to editors,
 * `canCreateJobs` to both; the service rejects a switch outside the target's role.
 */
export const SetPermissionsInput = z
  .strictObject({
    userId: IdSchema,
    canCreateJobs: z.boolean().optional(),
    canViewAllJobs: z.boolean().optional(),
    canAssignEditors: z.boolean().optional(),
    canReviewSubmissions: z.boolean().optional(),
    canViewTeamWorkloads: z.boolean().optional(),
    canViewAnalytics: z.boolean().optional(),
    canViewTeamJobs: z.boolean().optional(),
    expectedVersion: ExpectedVersionSchema,
  })
  .refine(
    (v) =>
      [v.canCreateJobs, v.canViewAllJobs, v.canAssignEditors, v.canReviewSubmissions, v.canViewTeamWorkloads, v.canViewAnalytics, v.canViewTeamJobs].some(
        (f) => f !== undefined,
      ),
    { message: "Nothing to change" },
  );
export type SetPermissionsInput = z.infer<typeof SetPermissionsInput>;

/**
 * POST /api/organisation/primary-owner { userId, expectedVersion } (§3.4).
 * `expectedVersion` is the organisation_settings row version.
 */
export const TransferPrimaryOwnerInput = z.strictObject({
  userId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
});
export type TransferPrimaryOwnerInput = z.infer<typeof TransferPrimaryOwnerInput>;

/** GET /api/clients/:id/portal-users (§7.1). */
export const ClientPortalUsersInput = z.strictObject({ clientId: IdSchema });
export type ClientPortalUsersInput = z.infer<typeof ClientPortalUsersInput>;

export const SetNotificationPrefsInput = z.object({
  /** Omitted → the actor. Only your own preferences can be changed. */
  userId: IdSchema.optional(),
  prefs: z.partialRecord(z.enum(NOTIFICATION_TYPES), z.boolean()),
});
export type SetNotificationPrefsInput = z.infer<typeof SetNotificationPrefsInput>;
