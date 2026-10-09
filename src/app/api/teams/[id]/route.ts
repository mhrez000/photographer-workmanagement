/** GET /api/teams/:id -> TeamDetail; PATCH { expectedVersion, name?, description?, leadUserId? } */
import { mutateById, readBy } from "@/app/api/_lib/route";
import { getTeamDetail } from "@/server/queries/teams";
import { updateTeam } from "@/server/services/teams";

export const GET = readBy((db, ctx, id) => getTeamDetail(db, ctx, id));
export const PATCH = mutateById("teamId", updateTeam);
