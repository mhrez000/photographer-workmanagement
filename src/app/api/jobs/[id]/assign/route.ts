/** POST /api/jobs/:id/assign { role: editor|photographer, userId | null, reason?, expectedVersion? } */
import { mutateById } from "@/app/api/_lib/route";
import { assignRole } from "@/server/services/assignments";

export const POST = mutateById("jobId", assignRole);
