/** Zod inputs for saved views and dashboard layouts (ARCHITECTURE.md §2.5). */
import { z } from "zod";
import { SAVED_VIEW_SCOPES } from "@/lib/constants";
import { DashboardLayoutSchema, SavedViewConfigSchema } from "./json";
import { ExpectedVersionSchema, IdSchema, NameSchema } from "./admin-shared";

export const CreateSavedViewInput = z.object({
  name: NameSchema(80),
  scope: z.enum(SAVED_VIEW_SCOPES),
  config: SavedViewConfigSchema,
  /** Shared with the whole organisation (requires saved_view.share). */
  isShared: z.boolean().optional(),
  /** The owner's default view for this scope (unsets their previous default). */
  isDefault: z.boolean().optional(),
});
export type CreateSavedViewInput = z.infer<typeof CreateSavedViewInput>;

export const UpdateSavedViewInput = z.object({
  viewId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  name: NameSchema(80).optional(),
  config: SavedViewConfigSchema.optional(),
  isShared: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});
export type UpdateSavedViewInput = z.infer<typeof UpdateSavedViewInput>;

export const DeleteSavedViewInput = z.object({ viewId: IdSchema, expectedVersion: ExpectedVersionSchema });
export type DeleteSavedViewInput = z.infer<typeof DeleteSavedViewInput>;

/** Dashboard layout save: shape + unique widget ids. */
export const PutDashboardLayoutInput = z.object({
  layout: DashboardLayoutSchema.refine(
    (l) => new Set(l.widgets.map((w) => w.id)).size === l.widgets.length,
    { message: "Widget ids must be unique", path: ["widgets"] },
  ),
  /** 0 = "I have no saved layout yet" (the role default was showing). */
  expectedVersion: z.number().int().min(0).optional(),
});
export type PutDashboardLayoutInput = z.infer<typeof PutDashboardLayoutInput>;
