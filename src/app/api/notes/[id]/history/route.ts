/** GET /api/notes/:id/history -> NoteHistoryEntry[] */
import { readBy, methodNotAllowed } from "@/app/api/_lib/route";
import { noteHistory } from "@/server/services/notes";

export const GET = readBy((db, ctx, id) => noteHistory(db, ctx, id));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
