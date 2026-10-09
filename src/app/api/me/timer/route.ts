/** GET /api/me/timer -> RunningSessionView | null */
import { read, methodNotAllowed } from "@/app/api/_lib/route";
import { runningSessionFor } from "@/server/services/timeTracking";

export const GET = read((db, ctx) => runningSessionFor(db, ctx));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
