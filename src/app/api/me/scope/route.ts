/**
 * POST /api/me/scope { scope: "mine" | "business" } → { scope }
 *
 * The "My shoots | Whole business" switch (docs/ROLES.md §8): stores the
 * choice in the `pwm_scope` cookie (path /, sameSite lax, httpOnly, 1 year).
 * A UI preference, like appearance — not audited. Only viewers who may switch
 * (`view.business_scope`: admins, team members with "See all jobs") can set
 * it; every list re-resolves the cookie through `resolveScope`, so a stale
 * cookie never widens anything.
 */
import { cookies } from "next/headers";
import { z } from "zod";
import { methodNotAllowed } from "@/app/api/_lib/route";
import { VIEW_SCOPES, VIEW_SCOPE_COOKIE } from "@/lib/constants";
import { assertCan } from "@/server/auth/permissions";
import { requireContext } from "@/server/auth/session";
import { bodyOrNull, handle } from "@/server/http";
import { VIEW_SCOPE_COOKIE_OPTIONS } from "@/server/view-scope";

const SetScopeInput = z.strictObject({ scope: z.enum(VIEW_SCOPES) });

export const POST = handle(async (req) => {
  const ctx = await requireContext();
  assertCan(ctx, "view.business_scope");
  const { scope } = SetScopeInput.parse((await bodyOrNull(req)) ?? {});
  const jar = await cookies();
  jar.set(VIEW_SCOPE_COOKIE, scope, { ...VIEW_SCOPE_COOKIE_OPTIONS, secure: process.env.NODE_ENV === "production" });
  return { scope };
});

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
