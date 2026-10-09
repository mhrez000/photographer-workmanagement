/** POST /api/automations/:id/dry-run { jobId, triggerEventId? } -> AutomationDryRunResult (no writes) */
import { getDb } from "@/db/index";
import { type IdParams, withFields } from "@/app/api/_lib/route";
import { requireContext } from "@/server/auth/session";
import { bodyOrNull, handle } from "@/server/http";
import { dryRun } from "@/server/services/automations";

export const POST = handle<IdParams>(async (req, { params }) => {
  const ctx = await requireContext();
  const { id } = await params;
  return dryRun(getDb(), ctx, withFields(await bodyOrNull(req), { automationId: id }));
});
