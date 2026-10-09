/** POST /api/jobs/:id/migrate-workflow { workflowId, toStatusId, expectedVersion, reason? } (O/M) */
import { mutateById } from "@/app/api/_lib/route";
import { migrateWorkflow } from "@/server/services/workflow";

export const POST = mutateById("jobId", migrateWorkflow);
