/** PATCH /api/statuses/:id { expectedVersion, name?, category?, colour?, description?, isInitial? } */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { updateStatus } from "@/server/services/workflows";

export const PATCH = mutateById("statusId", updateStatus);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["PATCH"]);
export const POST = methodNotAllowed(["PATCH"]);
export const PUT = methodNotAllowed(["PATCH"]);
export const DELETE = methodNotAllowed(["PATCH"]);
