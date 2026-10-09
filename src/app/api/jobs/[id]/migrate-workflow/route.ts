/** POST /api/jobs/:id/migrate-workflow { workflowId, toStatusId, expectedVersion, reason? } (O/M) */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { migrateWorkflow } from "@/server/services/workflow";

export const POST = mutateById("jobId", migrateWorkflow);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
