import { cookies } from "next/headers";
import { methodNotAllowed } from "@/app/api/_lib/route";
import { getDb } from "@/db/index";
import { requireAnyContext } from "@/server/auth/session";
import { bodyOrNull, clientIp, handle } from "@/server/http";
import { beginGoogleConnect } from "@/server/services/googleAuth";

/**
 * POST /api/auth/google/connect `{ password }` (self, any signed-in role) → `{ data: { redirectTo } }`: "Connect Google"
 * on My account. The current password comes first (SEC-03 — a new way in is never added by whoever is at an unlocked
 * computer): wrong → 400 `fieldErrors.password`, too many wrong ones → 429 (shared with Change password / email);
 * no password → 422; demo studio → 403; Google not set up → 404. Then the signed 10-minute round-trip cookie is set
 * and `redirectTo` is Google's account chooser (the page navigates there). The callback links Google and emails
 * "Google sign-in was added" to the account's address.
 */
export const POST = handle(async (req) => {
  const ctx = await requireAnyContext();
  const body = await bodyOrNull(req);
  const fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const started = await beginGoogleConnect(getDb(), req, ctx, {
    password: fields.password,
    ip: clientIp(req.headers),
    userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null,
  });
  const jar = await cookies();
  jar.set(started.cookie.name, started.cookie.value, started.cookie.options);
  return { redirectTo: started.location };
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
