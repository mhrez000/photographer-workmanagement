/** GET /api/jobs (filters, sort, groupBy, viewId, cursor, limit) -> JobListResult; POST /api/jobs (CreateJobInput) -> CreateJobResult */
import { mutate, read } from "@/app/api/_lib/route";
import { listJobs } from "@/server/queries/jobs";
import { createJob } from "@/server/services/jobs";

export const GET = read((db, ctx, q) => listJobs(db, ctx, q));
export const POST = mutate(createJob);
