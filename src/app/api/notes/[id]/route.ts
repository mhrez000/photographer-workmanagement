/** PATCH /api/notes/:id { expectedVersion, body?, isPinned? } */
import { mutateById } from "@/app/api/_lib/route";
import { editNote } from "@/server/services/notes";

export const PATCH = mutateById("noteId", editNote);
