/** POST /api/job-types/:id/archive { expectedVersion } */
import { mutateById } from "@/app/api/_lib/route";
import { archiveJobType } from "@/server/services/jobTypes";

export const POST = mutateById("jobTypeId", archiveJobType);
