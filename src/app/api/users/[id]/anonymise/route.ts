/** POST /api/users/:id/anonymise { expectedVersion } (owner; deactivated target) */
import { mutateById } from "@/app/api/_lib/route";
import { anonymiseUser } from "@/server/services/users";

export const POST = mutateById("userId", anonymiseUser);
