/** GET /api/workloads/:userId -> WorkloadDetail */
import { readBy } from "@/app/api/_lib/route";
import { getWorkloadDetail } from "@/server/queries/workloads";

export const GET = readBy((db, ctx, userId) => getWorkloadDetail(db, ctx, userId), "userId");
