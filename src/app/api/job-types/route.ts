/** GET /api/job-types?includeArchived=1 -> JobTypeView[]; POST { name, colour?, workflowId?, defaultEstimatedHours?, sortOrder? } */
import { flag, mutate, read, methodNotAllowed } from "@/app/api/_lib/route";
import { listJobTypes } from "@/server/queries/workflows";
import { createJobType } from "@/server/services/jobTypes";

export const GET = read((db, ctx, q) => listJobTypes(db, ctx, { includeArchived: flag(q, "includeArchived") }));
export const POST = mutate(createJobType);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const PUT = methodNotAllowed(["GET", "POST"]);
export const PATCH = methodNotAllowed(["GET", "POST"]);
export const DELETE = methodNotAllowed(["GET", "POST"]);
