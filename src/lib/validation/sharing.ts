/**
 * Zod schemas for the client-sharing service (docs/ROLES.md §7.1, §7.2):
 * project sharing and the per-client portal switches. Job and link sharing
 * live next to their entities (`ShareJobInput` in ./jobs, `ShareLinkInput`
 * in ./links). All strict: unknown keys → 400.
 */
import { z } from "zod";

const Id = z.string().trim().min(1).max(64);
const ExpectedVersion = z.number().int().positive();

/** `POST /api/projects/:id/share { shared, expectedVersion }` (admin: `project.share_with_client`). */
export const ShareProjectInput = z.strictObject({
  projectId: Id,
  shared: z.boolean(),
  expectedVersion: ExpectedVersion,
});
export type ShareProjectInput = z.input<typeof ShareProjectInput>;

/** `POST /api/clients/:id/portal { portalEnabled?, feedbackEnabled?, expectedVersion }` (admin: `client.manage_portal`). */
export const SetClientPortalInput = z
  .strictObject({
    clientId: Id,
    portalEnabled: z.boolean().optional(),
    feedbackEnabled: z.boolean().optional(),
    expectedVersion: ExpectedVersion,
  })
  .refine((v) => v.portalEnabled !== undefined || v.feedbackEnabled !== undefined, {
    message: "Nothing to change",
    path: ["portalEnabled"],
  });
export type SetClientPortalInput = z.input<typeof SetClientPortalInput>;
