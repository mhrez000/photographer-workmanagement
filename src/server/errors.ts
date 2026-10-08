/**
 * Domain errors thrown by services. `src/server/http.ts` maps them to HTTP
 * responses; server actions map them to form errors. Never throw raw strings.
 */

export type ErrorCode =
  | "validation"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_transition"
  | "ambiguous_target"
  | "editor_required"
  | "rate_limited"
  | "internal";

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: ErrorCode; message: string; details?: unknown } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

/** 400 — input failed Zod validation. `details` = flattened field errors. */
export class ValidationError extends AppError {
  constructor(message = "Invalid input", details?: unknown) {
    super(400, "validation", message, details);
  }
}

/** 401 — no/invalid session, inactive user, or stale session version. */
export class UnauthorizedError extends AppError {
  constructor(message = "Sign in required") {
    super(401, "unauthorized", message);
  }
}

/** 403 — authenticated but the policy denies `action` on the resource. */
export class ForbiddenError extends AppError {
  readonly action: string;
  constructor(action: string, message?: string) {
    super(403, "forbidden", message ?? `You do not have permission to ${action.replace(/[._]/g, " ")}`, { action });
    this.action = action;
  }
}

/** 404 — missing OR belongs to another organisation (existence never leaks). */
export class NotFoundError extends AppError {
  constructor(entity = "Resource", message?: string) {
    super(404, "not_found", message ?? `${entity} not found`);
  }
}

/** 409 — optimistic-concurrency failure. `current` = the row as it is now. */
export class ConflictError<T = unknown> extends AppError {
  readonly current: T | undefined;
  constructor(message = "This record was changed by someone else. Reload and try again.", current?: T) {
    super(409, "conflict", message, current === undefined ? undefined : { current });
    this.current = current;
  }
}

/** 422 — no workflow edge from → to (or actor may not take it). */
export class InvalidTransitionError extends AppError {
  constructor(
    readonly from: string,
    readonly to: string,
    message?: string,
    details?: unknown,
  ) {
    super(422, "invalid_transition", message ?? `Cannot move from "${from}" to "${to}"`, { from, to, ...(details && typeof details === "object" ? details : {}) });
  }
}

/** 422 — a category maps to several statuses in this workflow; caller must pick. */
export class AmbiguousTargetError extends AppError {
  constructor(readonly candidates: { id: string; name: string; key: string }[]) {
    super(422, "ambiguous_target", "Several statuses match; choose one", { candidates });
  }
}

/** 422 — the target status needs an active editor and the job has none. */
export class EditorRequiredError extends AppError {
  constructor(message = "Assign an editor before moving the job to this status") {
    super(422, "editor_required", message);
  }
}

/** 429 — login throttle. */
export class RateLimitedError extends AppError {
  constructor(readonly retryAfterSeconds: number) {
    super(429, "rate_limited", "Too many attempts. Try again later.", { retryAfterSeconds });
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
