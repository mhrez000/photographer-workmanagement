/**
 * POST /api/settings/close-delivered-jobs { confirm: true } -> CloseDeliveredJobsResult
 * (SIMPLIFICATION-PLAN §9: owner-confirmed; every Approved / Delivered job is completed one by one
 * through the normal recorded move; nothing is bulk-updated). Admin.
 */
import { mutate, methodNotAllowed } from "@/app/api/_lib/route";
import { closeDeliveredJobs } from "@/server/services/simple";

export const POST = mutate(closeDeliveredJobs);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
