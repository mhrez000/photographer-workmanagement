/** POST /api/jobs/:id/share { shared, expectedVersion } -> ShareJobResult (`job.share_with_client`, docs/ROLES.md §7.2) */
import { methodNotAllowed, mutateById } from "@/app/api/_lib/route";
import { shareJob } from "@/server/services/sharing";

export const POST = mutateById("jobId", shareJob);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
