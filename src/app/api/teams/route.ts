/** GET /api/teams?includeArchived -> TeamView[]; POST { name, description?, leadUserId?, memberIds? } */
import { mutate, read } from "@/app/api/_lib/route";
import { listTeams } from "@/server/queries/teams";
import { createTeam } from "@/server/services/teams";

export const GET = read((db, ctx, q) => listTeams(db, ctx, q));
export const POST = mutate(createTeam);
