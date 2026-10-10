/**
 * PATCH  /api/portal/comments/:id { body } -> PortalFeedbackMessage  (own feedback, 15-minute window)
 * DELETE /api/portal/comments/:id          -> PortalFeedbackMessage  (soft delete, own feedback)
 * Anything that is not the client's own client_feedback in their portal is 404 (docs/ROLES.md §7.5).
 */
import { methodNotAllowed, withFields, type IdParams } from "@/app/api/_lib/route";
import { requirePortalContext } from "@/server/auth/session";
import { bodyOrNull, handle } from "@/server/http";
import { withTxThenAutomations } from "@/server/services/_shared";
import { deletePortalFeedback, editPortalFeedback } from "@/server/services/portal";

export const PATCH = handle<IdParams>(async (req, { params }) => {
  const ctx = await requirePortalContext();
  const { id } = await params;
  const input = withFields(await bodyOrNull(req), { commentId: id });
  return withTxThenAutomations(ctx, (tx) => editPortalFeedback(tx, ctx, input));
});

export const DELETE = handle<IdParams>(async (_req, { params }) => {
  const ctx = await requirePortalContext();
  const { id } = await params;
  return withTxThenAutomations(ctx, (tx) => deletePortalFeedback(tx, ctx, { commentId: id }));
});

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["PATCH", "DELETE"]);
export const POST = methodNotAllowed(["PATCH", "DELETE"]);
export const PUT = methodNotAllowed(["PATCH", "DELETE"]);
