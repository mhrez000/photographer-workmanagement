/** PATCH /api/notes/:id { expectedVersion, body?, isPinned? } */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { editNote } from "@/server/services/notes";

export const PATCH = mutateById("noteId", editNote);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["PATCH"]);
export const POST = methodNotAllowed(["PATCH"]);
export const PUT = methodNotAllowed(["PATCH"]);
export const DELETE = methodNotAllowed(["PATCH"]);
