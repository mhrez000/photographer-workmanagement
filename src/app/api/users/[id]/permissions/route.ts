/**
 * POST /api/users/:id/permissions { canCreateJobs?, canViewAllJobs?, canAssignEditors?, canReviewSubmissions?,
 * canViewTeamWorkloads?, canViewAnalytics?, canViewTeamJobs?, expectedVersion } (docs/ROLES.md §6.1; replaces /visibility)
 */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { setPermissions } from "@/server/services/users";

export const POST = mutateById("userId", setPermissions);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
