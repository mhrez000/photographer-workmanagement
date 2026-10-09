/** GET /api/views/:id -> SavedViewItem; PATCH { expectedVersion, name?, config?, isShared?, isDefault? }; DELETE ?expectedVersion= (archive) */
import { mutateById, readBy, methodNotAllowed } from "@/app/api/_lib/route";
import { getSavedView } from "@/server/queries/views";
import { deleteSavedView, updateSavedView } from "@/server/services/savedViews";

export const GET = readBy((db, ctx, id) => getSavedView(db, ctx, id));
export const PATCH = mutateById("viewId", updateSavedView);
export const DELETE = mutateById("viewId", deleteSavedView, { withQuery: true });

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET", "PATCH", "DELETE"]);
export const PUT = methodNotAllowed(["GET", "PATCH", "DELETE"]);
