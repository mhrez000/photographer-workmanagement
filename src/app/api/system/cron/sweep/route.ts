import { getDb } from "@/db/index";
import { cronSecret, isAuthorisedCronRequest, sweepAllOrganisations } from "@/server/cron";
import { errorJson, json } from "@/server/http";
import { methodNotAllowed } from "@/app/api/_lib/route";

/**
 * GET|POST /api/system/cron/sweep — scheduler entry point.
 * Auth: `Authorization: Bearer $CRON_SECRET` (no session, no Origin: this is
 * server-to-server). 404 when CRON_SECRET is not configured, 401 on a wrong or
 * missing secret. Runs the sweep (overdue, review overdue, workload bands,
 * editor unavailable, session timeouts, pending automations) for every org.
 * GET is accepted because common schedulers (e.g. Vercel Cron) only send GET.
 */
function run(req: Request): Response {
  const secret = cronSecret();
  if (!secret) return errorJson(404, { code: "not_found", message: "Scheduler endpoint is disabled (CRON_SECRET not set)" });
  if (!isAuthorisedCronRequest(req.headers.get("authorization"), secret)) {
    return errorJson(401, { code: "unauthorized", message: "Invalid scheduler credentials" });
  }
  return json(sweepAllOrganisations(getDb()));
}

export const GET = run;
export const POST = run;
export const PUT = methodNotAllowed(["GET", "POST"]);
export const PATCH = methodNotAllowed(["GET", "POST"]);
export const DELETE = methodNotAllowed(["GET", "POST"]);
