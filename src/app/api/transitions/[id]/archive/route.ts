/** POST /api/transitions/:id/archive */
import { mutateById } from "@/app/api/_lib/route";
import { archiveTransition } from "@/server/services/workflows";

export const POST = mutateById("transitionId", archiveTransition);
