/** POST /api/users/:id/visibility { canViewTeamWorkloads?, canViewAnalytics?, expectedVersion } */
import { mutateById } from "@/app/api/_lib/route";
import { setVisibilityFlags } from "@/server/services/users";

export const POST = mutateById("userId", setVisibilityFlags);
