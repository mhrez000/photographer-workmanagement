/** Zod inputs for the teams service (ARCHITECTURE.md §2.1). */
import { z } from "zod";
import { ExpectedVersionSchema, IdSchema, NameSchema, OptionalTextSchema } from "./admin-shared";

export const CreateTeamInput = z.object({
  name: NameSchema(120),
  description: OptionalTextSchema(1000),
  leadUserId: IdSchema.nullish(),
  memberIds: z.array(IdSchema).max(200).optional(),
});
export type CreateTeamInput = z.infer<typeof CreateTeamInput>;

export const UpdateTeamInput = z.object({
  teamId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  name: NameSchema(120).optional(),
  description: OptionalTextSchema(1000),
  leadUserId: IdSchema.nullish(),
});
export type UpdateTeamInput = z.infer<typeof UpdateTeamInput>;

export const ArchiveTeamInput = z.object({ teamId: IdSchema, expectedVersion: ExpectedVersionSchema });
export type ArchiveTeamInput = z.infer<typeof ArchiveTeamInput>;

export const TeamMemberInput = z.object({ teamId: IdSchema, userId: IdSchema });
export type TeamMemberInput = z.infer<typeof TeamMemberInput>;
