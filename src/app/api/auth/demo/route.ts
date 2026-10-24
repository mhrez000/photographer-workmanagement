import { methodNotAllowed } from "@/app/api/_lib/route";
import { getDb } from "@/db/index";
import { bodyOrNull, clientIp, handle } from "@/server/http";
import { demoSignIn } from "@/server/services/demo";

/**
 * POST /api/auth/demo `{ persona: "owner" | "photographer" | "editor" | "client" }` (public, CSRF, 30 / 10 min per
 * client IP → 429) → `{ data: { redirectTo, user: { id, name, role } } }` + session cookie: this browser is signed in
 * to the shared demo studio as that persona ("Look around the demo" on the sign-in page). `DEMO_SIGN_IN=off`, or no
 * demo studio on this deployment → 404 "The demo studio is turned off". No email or password is involved.
 */
export const POST = handle(async (req, _ctx, meta) => {
  const body = await bodyOrNull(req);
  const fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  return demoSignIn(
    getDb(),
    { persona: fields.persona, ip: clientIp(req.headers), userAgent: req.headers.get("user-agent") },
    { requestId: meta.requestId },
  );
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
