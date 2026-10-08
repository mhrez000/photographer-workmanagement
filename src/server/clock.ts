/**
 * Injectable clock. Production uses the real clock; the seed and tests move
 * it (`setClock`) so generated history has realistic, deterministic timestamps.
 * Services must take timestamps from `ctx.now()` (which is built from here),
 * never from `new Date()` directly.
 */

let current: () => Date = () => new Date();

export function now(): Date {
  return current();
}

export function nowIso(): string {
  return current().toISOString();
}

/** Override the clock. Pass a fixed Date, an ISO string, or a function. */
export function setClock(value: Date | string | (() => Date)): void {
  if (typeof value === "function") current = value;
  else {
    const fixed = value instanceof Date ? value : new Date(value);
    current = () => new Date(fixed.getTime());
  }
}

/** Move a fixed clock forward by `ms` (no-op semantics for a function clock). */
export function advanceClock(ms: number): void {
  const base = current().getTime() + ms;
  current = () => new Date(base);
}

export function resetClock(): void {
  current = () => new Date();
}
