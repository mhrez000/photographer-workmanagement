/** POST /api/teams/:id/archive { expectedVersion } */
import { mutateById } from "@/app/api/_lib/route";
import { archiveTeam } from "@/server/services/teams";

export const POST = mutateById("teamId", archiveTeam);
