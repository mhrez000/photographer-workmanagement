/**
 * Browser-side client for the REST API (`src/app/api/**`). Every route returns
 * `{ data }` on success and `{ error: { code, message, details?, current? } }`
 * on failure (see `src/server/http.ts`). Client components call these helpers;
 * they never talk to the database or services directly.
 *
 * Same-origin `fetch` sends the session cookie and an `Origin` header, which
 * satisfies the CSRF check on non-GET routes.
 */

export type ApiErrorCode =
  | "validation"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_transition"
  | "ambiguous_target"
  | "editor_required"
  | "rate_limited"
  | "internal"
  | "network";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;
  /** For 409 conflicts: the record as it is now on the server. */
  readonly current: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown, current?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.current = current;
  }

  get isConflict(): boolean {
    return this.code === "conflict";
  }

  /** Field errors from a Zod validation failure, if any. */
  get fieldErrors(): Record<string, string[]> {
    const d = this.details as { fieldErrors?: Record<string, string[]> } | undefined;
    return d?.fieldErrors ?? {};
  }
}

type Query = Record<string, string | number | boolean | null | undefined | readonly (string | number)[]>;

export function buildQuery(query?: Query): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) value.forEach((v) => params.append(key, String(v)));
    else params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  headers?: HeadersInit;
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const url = `${path}${buildQuery(opts.query)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: opts.signal,
      headers: {
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "network", "Network error — check your connection and try again.");
  }

  let payload: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const error = (payload as { error?: { code?: ApiErrorCode; message?: string; details?: unknown; current?: unknown } } | null)?.error;
    if (res.status === 401 && typeof window !== "undefined") {
      // Session expired or revoked: bounce to login, preserving where we were.
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.assign(`/login?expired=1&next=${next}`);
    }
    throw new ApiError(
      res.status,
      error?.code ?? (res.status === 404 ? "not_found" : res.status === 403 ? "forbidden" : "internal"),
      error?.message ?? `Request failed (${res.status})`,
      error?.details,
      error?.current,
    );
  }

  return ((payload as { data?: T } | null)?.data ?? (undefined as T)) as T;
}

export const api = {
  get: <T>(path: string, opts?: Omit<RequestOptions, "body">) => request<T>("GET", path, opts),
  post: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, "body">) => request<T>("POST", path, { ...opts, body: body ?? {} }),
  patch: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, "body">) => request<T>("PATCH", path, { ...opts, body: body ?? {} }),
  put: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, "body">) => request<T>("PUT", path, { ...opts, body: body ?? {} }),
  delete: <T>(path: string, opts?: Omit<RequestOptions, "body">) => request<T>("DELETE", path, opts),
};

/** Human message for any thrown value (for toasts). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong";
}
