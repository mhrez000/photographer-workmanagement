/**
 * POST /api/me/scope — REMOVED (docs/SIMPLIFICATION-PLAN.md §8 "Removed: the My shoots / Whole
 * business switch, its notice and its cookie"). The owner always sees everything, so the endpoint
 * answers 404 for every method after auth, like a hidden Advanced route. The `pwm_scope` cookie is
 * no longer written anywhere; list queries still resolve it conservatively (never a widening).
 */
import { requireContext } from "@/server/auth/session";
import { NotFoundError } from "@/server/errors";
import { handle } from "@/server/http";

const gone = handle(async () => {
  await requireContext();
  throw new NotFoundError("Page", 'The "My shoots / Whole business" switch was removed; you always see everything you may see');
});

export const GET = gone;
export const POST = gone;
export const PUT = gone;
export const PATCH = gone;
export const DELETE = gone;
