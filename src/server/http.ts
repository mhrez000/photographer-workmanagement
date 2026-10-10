/**
 * Route-handler kernel (ARCHITECTURE.md §1 Errors, §3.3 CSRF, §9 API).
 *
 *   export const POST = handle(async (req) => {
 *     const ctx = await requireContext();
 *     const body = await bodyOrNull(req);
 *     return withTx((tx) => service(tx, ctx, body));   // async service → { data }
 *   });
 *
 * - success: a returned `Response` passes through; anything else → `{ data }` 200
 * - AppError → `{ error: { code, message, details?, current? } }` with its status
 * - ZodError (should not escape services, but just in case) → 400 validation
 * - unknown → 500 `{ error: { code: "internal", message, requestId } }`; logged
 *   server-side, never a stack in the body
 * - CSRF: every non-GET/HEAD/OPTIONS request must carry an `Origin` that
 *   matches `APP_ORIGIN` (when set) or the `Host` header, else 403.
 *   `X-Forwarded-Host` is honoured only behind trusted proxies
 *   (`TRUSTED_PROXY_COUNT` > 0) — a client can send any header it likes
 * - client IP (`clientIp`): `X-Forwarded-For` / `X-Real-IP` are ignored
 *   unless `TRUSTED_PROXY_COUNT` > 0 (see there)
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

function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Number of reverse proxies in front of the app that each append to
 * `X-Forwarded-For` (env `TRUSTED_PROXY_COUNT`, default 0). With 0 every
 * forwarding header is client-controlled and therefore ignored.
 */
export function trustedProxyCount(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env.TRUSTED_PROXY_COUNT?.trim();
  if (!raw || !/^\d+$/.test(raw)) return 0;
  return Math.min(Number(raw), 32);
}

/**
 * The hop a chain of `trusted` proxies vouches for in a comma-separated
 * forwarding header: index `len - trusted` (the value the outermost trusted
 * proxy appended). Anything left of it was supplied by the client.
 */
function trustedHop(value: string | null | undefined, trusted: number): string | null {
  if (trusted <= 0 || !value) return null;
  const hops = value
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  if (hops.length === 0) return null;
  return hops[Math.max(0, hops.length - trusted)] ?? null;
}

export interface OriginCheckOptions {
  /** Defaults to `trustedProxyCount()`. */
  trustedProxies?: number;
  /** Canonical app origin (env `APP_ORIGIN`); when set, Origin must equal it. */
  appOrigin?: string | null;
}

/**
 * True when the request passes the CSRF Origin rule (safe methods always pass):
 * Origin must equal `APP_ORIGIN` when configured, else its host must equal the
 * `Host` header (or, behind trusted proxies only, `X-Forwarded-Host`).
 */
export function isSameOrigin(req: Request, opts: OriginCheckOptions = {}): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
  const rawOrigin = req.headers.get("origin");
  const origin = hostOf(rawOrigin);
  if (!origin) return false;
  const appOrigin = originOf(opts.appOrigin === undefined ? process.env.APP_ORIGIN?.trim() : opts.appOrigin);
  if (appOrigin) return originOf(rawOrigin) === appOrigin;
  const trusted = opts.trustedProxies ?? trustedProxyCount();
  const forwarded = trustedHop(req.headers.get("x-forwarded-host"), trusted)?.toLowerCase();
  const host = forwarded || req.headers.get("host")?.trim().toLowerCase() || hostOf(req.url);
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
            { code: "forbidden", message: "Cross-site request blocked (Origin does not match this site)" },
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

/**
 * Client IP for rate limiting and audit metadata. `X-Forwarded-For` /
 * `X-Real-IP` are client-controlled, so they are ignored unless
 * `TRUSTED_PROXY_COUNT` (> 0) says how many proxies append to XFF; then the
 * hop at index `len - TRUSTED_PROXY_COUNT` is used. Otherwise null (route
 * handlers get no socket peer), which the login limiter buckets as one
 * stable "unknown" address — the per-email limiter still applies.
 */
export function clientIp(headers: Headers, trustedProxies: number = trustedProxyCount()): string | null {
  if (trustedProxies <= 0) return null;
  return trustedHop(headers.get("x-forwarded-for"), trustedProxies) || headers.get("x-real-ip")?.trim() || null;
}

/** True when the request comes from a plain HTML form navigation (not fetch/XHR). */
export function wantsHtml(req: Request): boolean {
  const accept = req.headers.get("accept") ?? "";
  return accept.includes("text/html");
}
