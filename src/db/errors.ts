/**
 * Postgres error helpers (both drivers).
 *
 * Drizzle wraps every failed query in `DrizzleQueryError` whose message is
 * "Failed query: …" — the real Postgres error (SQLSTATE `code`, trigger
 * message, constraint name) is on `.cause`. Never match on `err.message`
 * of a DB error; use these helpers.
 *
 * Remember: in Postgres a failed statement ABORTS the surrounding
 * transaction. If you intend to catch a DB error and keep going inside the
 * same transaction, run the statement in a savepoint:
 * `await tx.transaction(async (sp) => …)` and catch outside it.
 */

export interface PgErrorInfo {
  /** SQLSTATE, e.g. "23505" unique_violation, "P0001" guard trigger (RAISE EXCEPTION). */
  code: string;
  message: string;
  constraint?: string;
  table?: string;
  detail?: string;
}

/** SQLSTATE codes the app cares about. */
export const PG_CODES = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  notNullViolation: "23502",
  checkViolation: "23514",
  /** RAISE EXCEPTION from the integrity triggers (drizzle/0001_guards.sql). */
  raiseException: "P0001",
  serializationFailure: "40001",
  deadlockDetected: "40P01",
} as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Walks `err` and its `.cause` chain and returns the first Postgres error found. */
export function pgError(err: unknown): PgErrorInfo | null {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const rec = asRecord(current);
    if (!rec) return null;
    const code = rec.code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
      const str = (k: string): string | undefined => (typeof rec[k] === "string" ? (rec[k] as string) : undefined);
      // postgres-js uses constraint_name / table_name; PGlite (pg-protocol) uses constraint / table.
      return {
        code,
        message: str("message") ?? "",
        constraint: str("constraint") ?? str("constraint_name"),
        table: str("table") ?? str("table_name"),
        detail: str("detail"),
      };
    }
    current = rec.cause;
  }
  return null;
}

/** The most useful message: the Postgres error's when there is one, else the error's own. */
export function rootErrorMessage(err: unknown): string {
  const pg = pgError(err);
  if (pg?.message) return pg.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** unique_violation (optionally on one named constraint / unique index). */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const pg = pgError(err);
  return pg?.code === PG_CODES.uniqueViolation && (constraint === undefined || pg.constraint === constraint);
}

/** A rejection by one of the integrity triggers (append-only, fill-once, jobs consistency). */
export function isGuardViolation(err: unknown): boolean {
  return pgError(err)?.code === PG_CODES.raiseException;
}

/** check_violation (optionally on one named CHECK constraint, e.g. "users_role_ck"). */
export function isCheckViolation(err: unknown, constraint?: string): boolean {
  const pg = pgError(err);
  return pg?.code === PG_CODES.checkViolation && (constraint === undefined || pg.constraint === constraint);
}
