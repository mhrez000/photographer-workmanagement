/** POST /api/projects/:id/archive { expectedVersion } */
import { mutateById } from "@/app/api/_lib/route";
import { archiveProject } from "@/server/services/projects";

export const POST = mutateById("projectId", archiveProject);
