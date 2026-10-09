/** POST /api/job-types/:id/restore { expectedVersion } */
import { mutateById } from "@/app/api/_lib/route";
import { restoreJobType } from "@/server/services/jobTypes";

export const POST = mutateById("jobTypeId", restoreJobType);
