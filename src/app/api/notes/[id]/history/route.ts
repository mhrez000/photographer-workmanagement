/** GET /api/notes/:id/history -> NoteHistoryEntry[] */
import { readBy } from "@/app/api/_lib/route";
import { noteHistory } from "@/server/services/notes";

export const GET = readBy((db, ctx, id) => noteHistory(db, ctx, id));
