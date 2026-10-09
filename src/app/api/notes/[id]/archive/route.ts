/** POST /api/notes/:id/archive { expectedVersion? } */
import { mutateById } from "@/app/api/_lib/route";
import { archiveNote } from "@/server/services/notes";

export const POST = mutateById("noteId", archiveNote);
