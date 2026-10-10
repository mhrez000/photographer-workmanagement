/**
 * Helpers shared by the admin / structure services (clients, projects,
 * users, teams, settings, workflows, job types, saved views, dashboards).
 * Internal: not part of the public service surface.
 */
import { endOfCivilDayIso } from "@/lib/dates";
import { isCivilDate } from "@/lib/validation/admin-shared";
import { ConflictError, ValidationError } from "@/server/errors";

/** 400 for a business rule (archive blocked, last owner, …) with a form-level message. */
export function ruleViolation(message: string, extra: Record<string, unknown> = {}, field?: string): ValidationError {
  return new ValidationError(message, {
    formErrors: field ? [] : [message],
    fieldErrors: field ? { [field]: [message] } : {},
    ...extra,
  });
}

/** Optimistic concurrency check (only when the caller sent a version). `current` is what the 409 carries. */
export function checkVersion<T>(row: { version: number }, expectedVersion: number | undefined, current: T): void {
  if (expectedVersion !== undefined && row.version !== expectedVersion) {
    throw new ConflictError(undefined, current);
  }
}

/**
 * Calendar input → stored instant: `YYYY-MM-DD` becomes end of that day in
 * the org timezone (ARCHITECTURE.md §1); ISO strings are normalised.
 * `undefined` passes through (= "not provided").
 */
export function toStoredDate(value: string | null | undefined, timeZone: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return isCivilDate(value) ? endOfCivilDayIso(value, timeZone) : new Date(value).toISOString();
}

/**
 * Compares `patch` against `row` for `keys`; returns the changed subset as
 * previous/next snapshots (for the audit event) and the values to write.
 */
export function diffFields<R extends object, K extends keyof R & string>(
  row: R,
  patch: Partial<Record<K, unknown>>,
  keys: readonly K[],
): { changed: K[]; previous: Record<string, unknown>; next: Record<string, unknown>; set: Partial<Pick<R, K>> } {
  const changed: K[] = [];
  const previous: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  const set: Partial<Pick<R, K>> = {};
  for (const key of keys) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === row[key]) continue;
    changed.push(key);
    previous[key] = row[key];
    next[key] = value;
    (set as Record<string, unknown>)[key] = value;
  }
  return { changed, previous, next, set };
}

/** Lowercase slug from a display name (status keys). */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return /^[a-z]/.test(slug) ? slug : `s_${slug || "status"}`.slice(0, 48);
}

/**
 * Structural JSON equality that ignores object key order. jsonb columns
 * normalise key order on write, so `JSON.stringify(stored) === JSON.stringify(input)`
 * would report a change for an identical value read back from Postgres.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
