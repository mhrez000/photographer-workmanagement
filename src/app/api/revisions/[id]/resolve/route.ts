/** POST /api/revisions/:id/resolve { expectedVersion (JOB version), note?, toStatusId? } (= -> resubmitted) */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { resolveRevision } from "@/server/services/revisions";

export const POST = mutateById("revisionId", resolveRevision);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
