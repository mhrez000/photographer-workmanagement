/** POST /api/jobs/bulk/transition - one transaction per job -> BulkResult (200 even when some fail) */
import { requireContext } from "@/server/auth/session";
import { bodyOrNull, handle } from "@/server/http";
import { bulkTransition } from "@/server/services/jobs";
import { methodNotAllowed } from "@/app/api/_lib/route";

export const POST = handle(async (req) => {
  const ctx = await requireContext();
  return bulkTransition(ctx, await bodyOrNull(req));
});

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
