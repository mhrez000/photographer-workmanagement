/** GET /api/users/:id -> UserDetailView; PATCH { expectedVersion, name?, title?, avatarColour?, email? } */
import { mutateById, readBy, methodNotAllowed } from "@/app/api/_lib/route";
import { getUserDetail } from "@/server/queries/users";
import { updateUser } from "@/server/services/users";

export const GET = readBy((db, ctx, id) => getUserDetail(db, ctx, id));
export const PATCH = mutateById("userId", updateUser);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET", "PATCH"]);
export const PUT = methodNotAllowed(["GET", "PATCH"]);
export const DELETE = methodNotAllowed(["GET", "PATCH"]);
