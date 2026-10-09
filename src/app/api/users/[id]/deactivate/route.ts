/** POST /api/users/:id/deactivate { reassignTo? | unassign?, reason?, expectedVersion } -> DeactivateResult */
import { mutateById } from "@/app/api/_lib/route";
import { deactivateUser } from "@/server/services/users";

export const POST = mutateById("userId", deactivateUser);
