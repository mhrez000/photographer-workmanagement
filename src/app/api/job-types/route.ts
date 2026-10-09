/** GET /api/job-types?includeArchived=1 -> JobTypeView[]; POST { name, colour?, workflowId?, defaultEstimatedHours?, sortOrder? } */
import { flag, mutate, read } from "@/app/api/_lib/route";
import { listJobTypes } from "@/server/queries/workflows";
import { createJobType } from "@/server/services/jobTypes";

export const GET = read((db, ctx, q) => listJobTypes(db, ctx, { includeArchived: flag(q, "includeArchived") }));
export const POST = mutate(createJobType);
