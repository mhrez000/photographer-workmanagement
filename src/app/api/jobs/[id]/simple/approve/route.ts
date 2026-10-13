/**
 * POST /api/jobs/:id/simple/approve { expectedVersion, share: "send" | "only" | "n/a", confirmSelfApproval?, shareLinkIds? }
 *   -> ApproveJobResult — the one Approve (SIMPLIFICATION-PLAN §5, decisions 2 + 3): "send" = Approve & send
 *   (Approved → Delivered → Completed, sharing the finished links), "only" = Approve only, "n/a" = the
 *   client has no portal (Approved → Completed).
 * GET  /api/jobs/:id/simple/approve -> { shareChoice: "ask" | "n/a" } — whether the UI must ask
 *   "Share with <client>?" (portal on) or finish straight away. The ApproveButton reads the same answer
 *   from the page model (`nextStep.shareQuestion`); this GET serves API clients.
 */
import { methodNotAllowed, mutateById, readBy } from "@/app/api/_lib/route";
import { approveJob, approveShareChoiceFor } from "@/server/services/simple";

export const GET = readBy(async (db, ctx, id) => ({ shareChoice: await approveShareChoiceFor(db, ctx, id) }));
export const POST = mutateById("jobId", approveJob);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const PUT = methodNotAllowed(["GET", "POST"]);
export const PATCH = methodNotAllowed(["GET", "POST"]);
export const DELETE = methodNotAllowed(["GET", "POST"]);
