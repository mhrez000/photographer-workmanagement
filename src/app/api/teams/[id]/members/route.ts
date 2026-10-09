/** POST /api/teams/:id/members { userId } */
import { mutateById } from "@/app/api/_lib/route";
import { addMember } from "@/server/services/teams";

export const POST = mutateById("teamId", addMember);
