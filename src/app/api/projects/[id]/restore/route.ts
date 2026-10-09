/** POST /api/projects/:id/restore { expectedVersion } */
import { mutateById } from "@/app/api/_lib/route";
import { restoreProject } from "@/server/services/projects";

export const POST = mutateById("projectId", restoreProject);
