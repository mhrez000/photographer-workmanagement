import { getDb } from "@/db/index";
import { requireContext } from "@/server/auth/session";
import { handle } from "@/server/http";
import { runSweep } from "@/server/services/sweep";

/**
 * POST /api/system/sweep — runs the overdue / review-overdue / workload-band /
 * editor-unavailable / session-timeout sweep for the caller's organisation
 * now, then executes pending automation runs (ARCHITECTURE.md §8).
 * Requires `system.sweep` (owner, manager). Returns the SweepResult.
 */
export const POST = handle(async () => {
  const ctx = await requireContext();
  return runSweep(getDb(), ctx);
});
