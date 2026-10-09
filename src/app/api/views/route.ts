/** GET /api/views?scope -> SavedViewItem[]; POST { name, scope, config, isShared?, isDefault? } */
import { mutate, read, methodNotAllowed } from "@/app/api/_lib/route";
import { listSavedViews } from "@/server/queries/views";
import { createSavedView } from "@/server/services/savedViews";

export const GET = read((db, ctx, q) => listSavedViews(db, ctx, q));
export const POST = mutate(createSavedView);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const PUT = methodNotAllowed(["GET", "POST"]);
export const PATCH = methodNotAllowed(["GET", "POST"]);
export const DELETE = methodNotAllowed(["GET", "POST"]);
