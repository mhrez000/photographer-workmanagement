/** POST /api/jobs/:id/simple/send-for-checking — Send for checking: { expectedVersion, finishedLink: { url, label? } | { reuseCurrent: true }, note? } → Ready to check (docs/SIMPLIFICATION-PLAN.md §5). */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { sendForChecking } from "@/server/services/simple";

export const POST = mutateById("jobId", sendForChecking);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
