/**
 * Route-handler factories shared by every `src/app/api/**\/route.ts`
 * (ARCHITECTURE.md §9). Handlers stay thin: auth (`requireContext`) → call a
 * service or query → `{ data }`. Permission checks and input validation live
 * in the services / queries, never here.
 *
 * - Mutations run in ONE transaction via `withTxThenAutomations`, so pending
 *   automation runs execute right after the commit.
 * - Path params always win over body fields with the same name (a body
 *   cannot retarget another row).
 * - Query strings become plain objects (`?a=1&b=2&b=3` → `{ a: "1", b: ["2","3"] }`)
 *   and are parsed by the query's own Zod schema.
 */
import { getDb, type DbLike, type Tx } from "@/db/index";
import type { AuthContext } from "@/lib/types";
import { requireContext } from "@/server/auth/session";
import { bodyOrNull, errorJson, handle, searchParamsToObject } from "@/server/http";
import { withTxThenAutomations } from "@/server/services/_shared";

/** Next 16 route context: dynamic params arrive as a Promise. */
export interface RouteParams<P extends Record<string, string>> {
  params: Promise<P>;
}
export type IdParams = RouteParams<{ id: string }>;

type Query = Record<string, string | string[]>;
type Service = (tx: Tx, ctx: AuthContext, input: unknown) => unknown;

/** The request's query string as a plain object. */
export function queryOf(req: Request): Query {
  return searchParamsToObject(new URL(req.url));
}

/**
 * `{ ...body, ...extra }` when the body is a plain object (or empty); any
 * other body (array, string, number) is passed through untouched so the
 * service's own schema rejects it with a 400.
 */
export function withFields(body: unknown, extra: Record<string, unknown>): unknown {
  if (body === null || body === undefined) return { ...extra };
  if (typeof body === "object" && !Array.isArray(body)) return { ...(body as Record<string, unknown>), ...extra };
  return body;
}

/** GET without path params: `fn(db, ctx, query)`. */
export function read(fn: (db: DbLike, ctx: AuthContext, query: Query, req: Request) => unknown) {
  return handle(async (req) => {
    const ctx = await requireContext();
    return fn(getDb(), ctx, queryOf(req), req);
  });
}

/** GET on `/…/[param]`: `fn(db, ctx, value, query)`. */
export function readBy<K extends string = "id">(
  fn: (db: DbLike, ctx: AuthContext, value: string, query: Query, req: Request) => unknown,
  param: K = "id" as K,
) {
  return handle<RouteParams<Record<K, string>>>(async (req, { params }) => {
    const ctx = await requireContext();
    const value = (await params)[param];
    return fn(getDb(), ctx, value, queryOf(req), req);
  });
}

/** POST/PUT/PATCH without path params: body → service in one tx. */
export function mutate(service: Service) {
  return handle(async (req) => {
    const ctx = await requireContext();
    const input = await bodyOrNull(req);
    return withTxThenAutomations(ctx, (tx) => service(tx, ctx, input ?? {}));
  });
}

/**
 * POST/PATCH/DELETE on `/…/[id]`: `{ ...body, ...query?, [key]: id }` →
 * service in one tx. `withQuery` merges the query string first (DELETE
 * requests carry `expectedVersion` there because fetch sends no body).
 */
export function mutateById(key: string, service: Service, opts: { withQuery?: boolean; extra?: Record<string, unknown> } = {}) {
  return handle<IdParams>(async (req, { params }) => {
    const ctx = await requireContext();
    const { id } = await params;
    let body = await bodyOrNull(req);
    if (opts.withQuery) body = withFields(body, coerceQuery(queryOf(req)));
    const input = withFields(body, { ...opts.extra, [key]: id });
    return withTxThenAutomations(ctx, (tx) => service(tx, ctx, input));
  });
}

/** Query-string scalars for mutation inputs: numeric strings → numbers, "true"/"false" → booleans. */
function coerceQuery(q: Query): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q)) {
    if (Array.isArray(v)) out[k] = v;
    else if (/^-?\d+$/.test(v)) out[k] = Number(v);
    else if (v === "true" || v === "false") out[k] = v === "true";
    else out[k] = v;
  }
  return out;
}

/** True for `?flag=1|true|yes`. */
export function flag(q: Query, key: string): boolean {
  const v = q[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s !== undefined && ["1", "true", "yes"].includes(s.toLowerCase());
}

/** First value of a query key. */
export function one(q: Query, key: string): string | undefined {
  const v = q[key];
  return Array.isArray(v) ? v[0] : v;
}

/** Methods a route file can export (HEAD/OPTIONS are derived by Next). */
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * JSON 404 for an `/api/*` path no route handles (the `[...path]` catch-all).
 * Runs through `handle`, so request ids and the CSRF check still apply.
 */
export function notFoundRoute() {
  return handle(async (req) => {
    const { pathname } = new URL(req.url);
    return errorJson(404, { code: "not_found", message: `No API route for ${req.method.toUpperCase()} ${pathname.slice(0, 200)}` });
  });
}

/**
 * JSON 405 for a method a route file does not implement (Next's own 405 has
 * an empty body). Export it under each missing method:
 *
 *   export const GET = methodNotAllowed(["POST"]);
 *
 * Body `{ error: { code: "method_not_allowed", message } }` + an `Allow` header.
 */
export function methodNotAllowed(allowed: readonly HttpMethod[]) {
  const allow = allowed.join(", ");
  return handle(async (req) =>
    Response.json(
      { error: { code: "method_not_allowed", message: `${req.method.toUpperCase()} is not supported here. Allowed: ${allow}` } },
      { status: 405, headers: { allow } },
    ),
  );
}
