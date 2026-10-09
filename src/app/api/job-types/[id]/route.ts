/** PATCH /api/job-types/:id { expectedVersion, name?, colour?, workflowId?, defaultEstimatedHours?, sortOrder? } */
import { mutateById } from "@/app/api/_lib/route";
import { updateJobType } from "@/server/services/jobTypes";

export const PATCH = mutateById("jobTypeId", updateJobType);
