/** POST /api/jobs/:id/transition { toStatusId | toCategory, expectedVersion, reason?, override?, revision?, startTimer? } -> TransitionResult */
import { mutateById } from "@/app/api/_lib/route";
import { transitionJobStatus } from "@/server/services/workflow";

export const POST = mutateById("jobId", transitionJobStatus);
