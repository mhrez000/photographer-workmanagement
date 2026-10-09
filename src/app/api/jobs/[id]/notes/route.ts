/** GET /api/jobs/:id/notes?includeArchived=1 -> NoteView[]; POST { kind, body, revisionId? } */
import { flag, mutateById, readBy } from "@/app/api/_lib/route";
import { addNote, listNotes } from "@/server/services/notes";

export const GET = readBy((db, ctx, id, q) => listNotes(db, ctx, id, { includeArchived: flag(q, "includeArchived") }));
export const POST = mutateById("jobId", addNote);
