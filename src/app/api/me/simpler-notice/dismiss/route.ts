/** POST /api/me/simpler-notice/dismiss -> SafeUser (the one-time "Proofline got simpler" card; self; idempotent). */
import { mutate, methodNotAllowed } from "@/app/api/_lib/route";
import { dismissSimplerNotice } from "@/server/services/simple";

export const POST = mutate((tx, ctx) => dismissSimplerNotice(tx, ctx));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
