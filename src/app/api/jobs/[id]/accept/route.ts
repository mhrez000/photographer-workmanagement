/** POST /api/jobs/:id/accept { expectedVersion, toStatusId?, reason? } - assigned -> accepted (assigned editor; O/M on behalf) */
import { mutateById } from "@/app/api/_lib/route";
import { acceptJob } from "@/server/services/workflow";

export const POST = mutateById("jobId", acceptJob);
