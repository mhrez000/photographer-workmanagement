/** GET /api/my-jobs -> MyJobs — the editor's home: Changes asked · Late · To do · Waiting for a check · Done recently + their own numbers (SIMPLIFICATION-PLAN §6). Photographers get 403 (they use /api/home). */
import { methodNotAllowed, read } from "@/app/api/_lib/route";
import { getMyJobs } from "@/server/queries/myJobs";

export const GET = read((db, ctx) => getMyJobs(db, ctx));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
