/**
 * GET /api/reports?type=<kind>&range&format=json|csv — query-string form of
 * `/api/reports/:kind` (spec §36 "Reports API /api/reports?type=&range="). A
 * missing or unknown `type` is the same 404 as an unknown kind.
 */
import { methodNotAllowed, one, read } from "@/app/api/_lib/route";
import { reportResponse } from "@/app/api/_lib/reports";

export const GET = read((db, ctx, q) => {
  const { type, ...rest } = q;
  return reportResponse(db, ctx, one({ type }, "type") ?? "", rest);
});

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
