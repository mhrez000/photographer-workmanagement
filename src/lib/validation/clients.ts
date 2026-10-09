/** Zod inputs for the clients service (ARCHITECTURE.md §2.2). */
import { z } from "zod";
import { ExpectedVersionSchema, HexColourSchema, IdSchema, NameSchema, OptionalEmailSchema, OptionalTextSchema } from "./admin-shared";

const ClientFields = {
  name: NameSchema(200),
  contactName: OptionalTextSchema(200),
  email: OptionalEmailSchema,
  phone: OptionalTextSchema(50),
  notes: OptionalTextSchema(5000),
  colour: HexColourSchema.optional(),
};

export const CreateClientInput = z.object(ClientFields);
export type CreateClientInput = z.infer<typeof CreateClientInput>;

export const UpdateClientInput = z.object({
  clientId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  name: ClientFields.name.optional(),
  contactName: ClientFields.contactName,
  email: ClientFields.email,
  phone: ClientFields.phone,
  notes: ClientFields.notes,
  colour: ClientFields.colour,
});
export type UpdateClientInput = z.infer<typeof UpdateClientInput>;

export const ArchiveClientInput = z.object({ clientId: IdSchema, expectedVersion: ExpectedVersionSchema });
export type ArchiveClientInput = z.infer<typeof ArchiveClientInput>;
