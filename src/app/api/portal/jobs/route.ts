/** GET /api/portal/jobs?sort=progress|delivered -> PortalJob[] (client portal, docs/ROLES.md §7.7) */
import { getDb } from "@/db/index";
import { methodNotAllowed, queryOf } from "@/app/api/_lib/route";
import { requirePortalContext } from "@/server/auth/session";
import { handle } from "@/server/http";
import { listPortalJobs } from "@/server/queries/portal";

export const GET = handle(async (req) => {
  const ctx = await requirePortalContext();
  return listPortalJobs(getDb(), ctx, queryOf(req));
});

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
