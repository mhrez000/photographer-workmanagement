/** GET /api/search?q&limit -> SearchResults */
import { one, read } from "@/app/api/_lib/route";
import { globalSearch } from "@/server/queries/search";

export const GET = read((db, ctx, q) => {
  const limit = Number(one(q, "limit"));
  return globalSearch(db, ctx, one(q, "q") ?? "", Number.isFinite(limit) && limit > 0 ? { limit } : {});
});
