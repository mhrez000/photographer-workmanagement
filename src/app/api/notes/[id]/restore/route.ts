/** POST /api/notes/:id/restore { expectedVersion? } */
import { mutateById } from "@/app/api/_lib/route";
import { restoreNote } from "@/server/services/notes";

export const POST = mutateById("noteId", restoreNote);
