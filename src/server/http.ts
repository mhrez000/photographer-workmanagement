/**
 * Route-handler kernel (ARCHITECTURE.md §1 Errors, §3.3 CSRF, §9 API).
 *
 *   export const POST = handle(async (req) => {
 *     const ctx = await requireContext();
 *     return withTx((tx) => service(tx, ctx, await bodyOrNull(req)));   // → { data }
 *   });
 *
 * - success: a returned `Response` passes through; anything else → `{ data }` 200
 * - AppError → `{ error: { code, message, details?, current? } }` with its status
 * - ZodError (should not escape services, but just in case) → 400 validation
 * - unknown → 500 `{ error: { code: "internal", message, requestId } }`; logged
 *   server-side, never a stack in the body
 * - CSRF: every non-GET/HEAD/OPTIONS request must carry an `Origin` whose host
 *   equals the request host, else 403
 * - every response carries `x-request-id`; the same id is in event metadata
 */
import { ZodError } from "zod";
import type { ApiErrorBody } from "@/lib/types";
import { AppError, ConflictError, RateLimitedError, isAppError } from "@/server/errors";
import { newRequestId, runWithRequestId } from "@/server/request-scope";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface HandlerMeta {
  requestId: string;
}

/** `{ data }` JSON response. */
export function json<T>(data: T, init?: ResponseInit): Response {
  return Response.json({ data }, init);
}

/** `{ error }` JSON response. */
export function errorJson(status: number, error: ApiErrorBody["error"] & { requestId?: string }, init?: ResponseInit): Response {
  return Response.json({ error }, { ...init, status });
}

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/** True when the request passes the Origin == Host CSRF rule (safe methods always pass). */
export function isSameOrigin(req: Request): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
  const origin = hostOf(req.headers.get("origin"));
  if (!origin) return false;
  const forwarded = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
  const host = forwarded || req.headers.get("host")?.toLowerCase() || hostOf(req.url);
  return origin === host;
}

/** Maps any thrown value to an error Response (logs unknown errors). */
export function errorResponse(err: unknown, requestId: string): Response {
  const headers = { "x-request-id": requestId };
  if (isAppError(err)) {
    const error: ApiErrorBody["error"] = { code: err.code, message: err.message };
    if (err instanceof ConflictError) {
      if (err.current !== undefined) error.current = err.current;
    } else if (err.details !== undefined) {
      error.details = err.details;
    }
    const extra: Record<string, string> = {};
    if (err instanceof RateLimitedError) extra["retry-after"] = String(err.retryAfterSeconds);
    return errorJson(err.status, error, { headers: { ...headers, ...extra } });
  }
  if (err instanceof ZodError) {
    return errorJson(400, { code: "validation", message: "Invalid input", details: { issues: err.issues } }, { headers });
  }
  console.error(`[api] unhandled error requestId=${requestId}`, err);
  return errorJson(
    500,
    { code: "internal", message: "Something went wrong. Try again, or quote the request id if it keeps happening.", requestId },
    { headers },
  );
}

/**
 * Wraps a route handler with request ids, CSRF and error mapping. The
 * second argument is Next's route context (`{ params: Promise<…> }`).
 */
export function handle<C = unknown>(
  fn: (req: Request, context: C, meta: HandlerMeta) => unknown,
): (req: Request, context: C) => Promise<Response> {
  return async (req, context) => {
    const requestId = req.headers.get("x-request-id")?.slice(0, 64) || newRequestId();
    return runWithRequestId(requestId, async () => {
      try {
        if (!isSameOrigin(req)) {
          return errorJson(
            403,
            { code: "forbidden", message: "Cross-site request blocked (Origin does not match Host)" },
            { headers: { "x-request-id": requestId } },
          );
        }
        const result = await fn(req, context, { requestId });
        if (result instanceof Response) {
          if (!result.headers.has("x-request-id")) {
            try {
              result.headers.set("x-request-id", requestId);
            } catch {
              // immutable headers (e.g. Response.redirect) — fine to skip
            }
          }
          return result;
        }
        return json(result === undefined ? null : result, { headers: { "x-request-id": requestId } });
      } catch (err) {
        return errorResponse(err, requestId);
      }
    });
  };
}

/**
 * Reads the body as `unknown`: JSON, or form data (urlencoded / multipart →
 * plain object; repeated keys → arrays). Empty body → null. Malformed JSON →
 * 400 ValidationError.
 */
export async function bodyOrNull(req: Request): Promise<unknown> {
  const type = req.headers.get("content-type")?.toLowerCase() ?? "";
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    const form = await req.formData();
    const out: Record<string, string | string[]> = {};
    for (const [key, value] of form.entries()) {
      if (typeof value !== "string") continue;
      const existing = out[key];
      if (existing === undefined) out[key] = value;
      else out[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    }
    return out;
  }
  const text = await req.text();
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError(400, "validation", "Malformed JSON body");
  }
}

/**
 * Query string → object. Repeated keys (or `key[]`) become arrays; a single
 * value stays a string: `?a=1&b=2&b=3&c[]=4` → `{ a: "1", b: ["2","3"], c: ["4"] }`.
 */
export function searchParamsToObject(input: URL | URLSearchParams | string): Record<string, string | string[]> {
  const params =
    input instanceof URLSearchParams ? input : input instanceof URL ? input.searchParams : new URL(input, "http://local").searchParams;
  const out: Record<string, string | string[]> = {};
  for (const [rawKey, value] of params.entries()) {
    const forceArray = rawKey.endsWith("[]");
    const key = forceArray ? rawKey.slice(0, -2) : rawKey;
    const existing = out[key];
    if (existing === undefined) out[key] = forceArray ? [value] : value;
    else out[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  return out;
}

/** Best-effort client IP (first X-Forwarded-For hop, else X-Real-IP). */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || null;
}

/** True when the request comes from a plain HTML form navigation (not fetch/XHR). */
export function wantsHtml(req: Request): boolean {
  const accept = req.headers.get("accept") ?? "";
  return accept.includes("text/html");
}
