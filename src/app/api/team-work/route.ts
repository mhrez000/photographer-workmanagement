/** GET /api/team-work?... -> TeamWorkGroup[] */
import { read } from "@/app/api/_lib/route";
import { getTeamWork } from "@/server/queries/teamWork";

export const GET = read((db, ctx, q) => getTeamWork(db, ctx, q));
