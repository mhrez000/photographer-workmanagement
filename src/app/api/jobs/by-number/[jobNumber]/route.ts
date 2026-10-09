/** GET /api/jobs/by-number/:jobNumber -> JobRow (404 when not visible) */
import { readBy } from "@/app/api/_lib/route";
import { getJobRowByNumber } from "@/server/queries/jobs";

export const GET = readBy((db, ctx, jobNumber) => getJobRowByNumber(db, ctx, decodeURIComponent(jobNumber)), "jobNumber");
