/** Zod inputs for the projects service (ARCHITECTURE.md §2.2). */
import { z } from "zod";
import { CalendarDateSchema, ExpectedVersionSchema, IdSchema, NameSchema, OptionalTextSchema } from "./admin-shared";

export const CreateProjectInput = z.object({
  clientId: IdSchema,
  name: NameSchema(200),
  address: OptionalTextSchema(500),
  description: OptionalTextSchema(5000),
  startDate: CalendarDateSchema,
  endDate: CalendarDateSchema,
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

export const UpdateProjectInput = z.object({
  projectId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  /** Moving a project to another client is only allowed while it has no jobs. */
  clientId: IdSchema.optional(),
  name: NameSchema(200).optional(),
  address: OptionalTextSchema(500),
  description: OptionalTextSchema(5000),
  startDate: CalendarDateSchema,
  endDate: CalendarDateSchema,
});
export type UpdateProjectInput = z.infer<typeof UpdateProjectInput>;

export const ArchiveProjectInput = z.object({ projectId: IdSchema, expectedVersion: ExpectedVersionSchema });
export type ArchiveProjectInput = z.infer<typeof ArchiveProjectInput>;
