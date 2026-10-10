/** GET /api/portal/jobs/:id -> PortalJobDetail; a job outside the client's portal is 404 (docs/ROLES.md §7.2) */
import { getDb } from "@/db/index";
import { methodNotAllowed, type IdParams } from "@/app/api/_lib/route";
import { requirePortalContext } from "@/server/auth/session";
import { handle } from "@/server/http";
import { getPortalJob } from "@/server/queries/portal";

export const GET = handle<IdParams>(async (_req, { params }) => {
  const ctx = await requirePortalContext();
  const { id } = await params;
  return getPortalJob(getDb(), ctx, id);
});

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
