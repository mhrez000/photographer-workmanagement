/** POST /api/portal/jobs/:id/feedback { body, parentCommentId? } -> PortalFeedbackMessage (docs/ROLES.md §7.5) */
import { methodNotAllowed, withFields, type IdParams } from "@/app/api/_lib/route";
import { requirePortalContext } from "@/server/auth/session";
import { bodyOrNull, handle } from "@/server/http";
import { withTxThenAutomations } from "@/server/services/_shared";
import { postPortalFeedback } from "@/server/services/portal";

export const POST = handle<IdParams>(async (req, { params }) => {
  const ctx = await requirePortalContext();
  const { id } = await params;
  const input = withFields(await bodyOrNull(req), { jobId: id });
  return withTxThenAutomations(ctx, (tx) => postPortalFeedback(tx, ctx, input));
});

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
