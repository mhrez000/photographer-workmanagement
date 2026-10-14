import { methodNotAllowed, mutate } from "@/app/api/_lib/route";
import { dismissOnboarding } from "@/server/services/settings";

/** POST /api/settings/onboarding/dismiss (admin) → `{ data: { dismissedAt, changed } }` — hides the first-run checklist (idempotent, audited). */
export const POST = mutate((tx, ctx) => dismissOnboarding(tx, ctx));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
