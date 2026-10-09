/** POST /api/jobs/bulk/priority - one transaction per job -> BulkResult (200 even when some fail) */
import { requireContext } from "@/server/auth/session";
import { bodyOrNull, handle } from "@/server/http";
import { bulkSetPriority } from "@/server/services/jobs";

export const POST = handle(async (req) => {
  const ctx = await requireContext();
  return bulkSetPriority(ctx, await bodyOrNull(req));
});
