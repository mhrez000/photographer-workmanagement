/** POST /api/jobs/bulk/reassign - one transaction per job -> BulkResult (200 even when some fail) */
import { requireContext } from "@/server/auth/session";
import { bodyOrNull, handle } from "@/server/http";
import { bulkReassign } from "@/server/services/assignments";

export const POST = handle(async (req) => {
  const ctx = await requireContext();
  return bulkReassign(ctx, await bodyOrNull(req));
});
