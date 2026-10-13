/** POST /api/job-types/:id/usual-days { usualDaysToEdit: number | null, expectedVersion? } -> JobType — Settings → Types of shoot: the usual days to edit that pre-fills a new job's due date (SIMPLIFICATION-PLAN §5; admin). */
import { methodNotAllowed, mutateById } from "@/app/api/_lib/route";
import { setJobTypeUsualDays } from "@/server/services/simple";

export const POST = mutateById("jobTypeId", setJobTypeUsualDays);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
