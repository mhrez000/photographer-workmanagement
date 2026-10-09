import { notFoundRoute } from "@/app/api/_lib/route";

/**
 * Catch-all for `/api/*` paths no route handles: a JSON 404
 * `{ error: { code: "not_found", message } }` instead of Next's HTML 404
 * page. Every specific route (static or dynamic) still wins over this one.
 */
export const GET = notFoundRoute();
export const POST = notFoundRoute();
export const PUT = notFoundRoute();
export const PATCH = notFoundRoute();
export const DELETE = notFoundRoute();
