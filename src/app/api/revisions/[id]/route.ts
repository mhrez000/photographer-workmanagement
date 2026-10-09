/** PATCH /api/revisions/:id { assigneeUserId?, instructions?, priority?, dueDate? } (open revisions only) */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { updateRevision } from "@/server/services/revisions";

export const PATCH = mutateById("revisionId", updateRevision);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["PATCH"]);
export const POST = methodNotAllowed(["PATCH"]);
export const PUT = methodNotAllowed(["PATCH"]);
export const DELETE = methodNotAllowed(["PATCH"]);
