/** POST /api/users/:id/reactivate { expectedVersion } */
import { mutateById } from "@/app/api/_lib/route";
import { reactivateUser } from "@/server/services/users";

export const POST = mutateById("userId", reactivateUser);
