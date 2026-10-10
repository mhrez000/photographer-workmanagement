/** GET /api/portal/projects/:id?sort= -> PortalProjectGroup (the project's shared jobs; none visible → 404) */
import { getDb } from "@/db/index";
import { methodNotAllowed, queryOf, type IdParams } from "@/app/api/_lib/route";
import { requirePortalContext } from "@/server/auth/session";
import { handle } from "@/server/http";
import { getPortalProject } from "@/server/queries/portal";

export const GET = handle<IdParams>(async (req, { params }) => {
  const ctx = await requirePortalContext();
  const { id } = await params;
  return getPortalProject(getDb(), ctx, id, queryOf(req));
});

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
