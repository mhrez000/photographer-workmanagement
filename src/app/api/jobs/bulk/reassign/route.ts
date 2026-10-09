/** POST /api/jobs/bulk/reassign - one transaction per job -> BulkResult (200 even when some fail) */
import { requireContext } from "@/server/auth/session";
import { bodyOrNull, handle } from "@/server/http";
import { bulkReassign } from "@/server/services/assignments";
import { methodNotAllowed } from "@/app/api/_lib/route";

export const POST = handle(async (req) => {
  const ctx = await requireContext();
  return bulkReassign(ctx, await bodyOrNull(req));
});

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
