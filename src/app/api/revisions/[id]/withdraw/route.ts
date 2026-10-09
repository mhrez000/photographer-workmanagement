/** POST /api/revisions/:id/withdraw { expectedVersion (JOB version), reason? } */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { withdrawRevision } from "@/server/services/revisions";

export const POST = mutateById("revisionId", withdrawRevision);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
