/** GET /api/search?q&limit -> SearchResults */
import { one, read, methodNotAllowed } from "@/app/api/_lib/route";
import { globalSearch } from "@/server/queries/search";

export const GET = read((db, ctx, q) => {
  const limit = Number(one(q, "limit"));
  return globalSearch(db, ctx, one(q, "q") ?? "", Number.isFinite(limit) && limit > 0 ? { limit } : {});
});

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
