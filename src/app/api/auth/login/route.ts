import { bodyOrNull, clientIp, handle } from "@/server/http";
import { login } from "@/server/services/auth";
import { methodNotAllowed } from "@/app/api/_lib/route";

/** POST /api/auth/login `{ email, password }` → `{ data: { user } }` + session cookie. */
export const POST = handle(async (req) => {
  const body = await bodyOrNull(req);
  const fields = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const user = await login({
    email: fields.email,
    password: fields.password,
    ip: clientIp(req.headers),
    userAgent: req.headers.get("user-agent"),
  });
  return { user: { id: user.id, name: user.name, email: user.email, role: user.role } };
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
