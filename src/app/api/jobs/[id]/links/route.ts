/** GET /api/jobs/:id/links?history=1 -> LinkSlot[]; POST { kind, url, label? } */
import { flag, mutateById, readBy, methodNotAllowed } from "@/app/api/_lib/route";
import { addLink, listLinks } from "@/server/services/links";

export const GET = readBy((db, ctx, id, q) => listLinks(db, ctx, id, { history: flag(q, "history") }));
export const POST = mutateById("jobId", addLink);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const PUT = methodNotAllowed(["GET", "POST"]);
export const PATCH = methodNotAllowed(["GET", "POST"]);
export const DELETE = methodNotAllowed(["GET", "POST"]);
