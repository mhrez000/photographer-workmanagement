/** POST /api/users/:id/role { role, expectedVersion } */
import { mutateById } from "@/app/api/_lib/route";
import { changeRole } from "@/server/services/users";

export const POST = mutateById("userId", changeRole);
