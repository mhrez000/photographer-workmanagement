/**
 * GET /api/team-work?... -> TeamWorkGroup[]
 * Same gate as the Team Work page (docs/ROLES.md §10.1: admins, members with "See all jobs",
 * editors with "See other editors' jobs"); rows are visibility-scoped by `getTeamWork` either way.
 */
import { read, methodNotAllowed } from "@/app/api/_lib/route";
import { ForbiddenError } from "@/server/errors";
import { canViewTeamWork } from "@/server/nav-gates";
import { getTeamWork } from "@/server/queries/teamWork";

export const GET = read((db, ctx, q) => {
  if (!canViewTeamWork(ctx)) throw new ForbiddenError("team_work.view", "Team Work is not part of your access");
  return getTeamWork(db, ctx, q);
});

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
