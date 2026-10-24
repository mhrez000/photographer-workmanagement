import { bodyOrNull, clientIp, handle } from "@/server/http";
import { login } from "@/server/services/auth";
import { loginRedirectTarget } from "@/server/auth/redirect";
import { methodNotAllowed } from "@/app/api/_lib/route";

/**
 * POST /api/auth/login `{ email, password, next? }` → `{ data: { user, redirectTo } }` + session cookie.
 * `redirectTo` is the persona's landing page (plan §3): owner / photographer `/home`, editor `/my-jobs`,
 * client `/portal` — never `/dashboard` (`loginRedirectTarget`). Too many failures (5 / 15 min per email + network,
 * 20 per email) → 429 "Too many sign-in attempts. Try again in N minutes." with `retry-after`.
 */
export const POST = handle(async (req) => {
  const body = await bodyOrNull(req);
  const fields = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const user = await login({
    email: fields.email,
    password: fields.password,
    ip: clientIp(req.headers),
    userAgent: req.headers.get("user-agent"),
  });
  return { user: { id: user.id, name: user.name, email: user.email, role: user.role }, redirectTo: loginRedirectTarget(user.role, fields.next) };
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
