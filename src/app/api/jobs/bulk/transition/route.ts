/** POST /api/jobs/bulk/transition - one transaction per job -> BulkResult (200 even when some fail) */
import { requireContext } from "@/server/auth/session";
import { bodyOrNull, handle } from "@/server/http";
import { bulkTransition } from "@/server/services/jobs";

export const POST = handle(async (req) => {
  const ctx = await requireContext();
  return bulkTransition(ctx, await bodyOrNull(req));
});
