/** GET /api/editors/options -> EditorPickerOption[] — the Assign / Change editor picker: every active editor with "On their desk N · Late N" and the optional "Usually handles up to N" (any staff member). */
import { methodNotAllowed, read } from "@/app/api/_lib/route";
import { editorPickerOptions } from "@/server/queries/editors";

export const GET = read((db, ctx) => editorPickerOptions(db, ctx));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
