/** POST /api/jobs/:id/start { expectedVersion, toStatusId?, reason? } - -> in_progress ({ startTimer? }) */
import { mutateById } from "@/app/api/_lib/route";
import { startJob } from "@/server/services/workflow";

export const POST = mutateById("jobId", startJob);
