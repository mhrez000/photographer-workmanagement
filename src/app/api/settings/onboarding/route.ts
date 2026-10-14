import { methodNotAllowed, read } from "@/app/api/_lib/route";
import { getOnboarding } from "@/server/queries/onboarding";

/**
 * GET /api/settings/onboarding → `{ data: OnboardingState | null }` — the first-run checklist for admins
 * (`steps { createdFirstJob, invitedEditor, addedClient, assignedEditor, approvedFirst }`, `completed`,
 * `dismissed`, `isNewStudio`, `show`); `null` for everyone else.
 */
export const GET = read((db, ctx) => getOnboarding(db, ctx));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
