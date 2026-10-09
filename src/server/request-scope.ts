/**
 * Per-request correlation id, carried with AsyncLocalStorage so code deep in
 * a request (requireContext → recordEvent metadata) sees the same id that
 * `handle()` returns in the `x-request-id` header and in 500 bodies.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { shortId } from "@/lib/ids";

const storage = new AsyncLocalStorage<{ requestId: string }>();

export function newRequestId(): string {
  return shortId(12);
}

/** Runs `fn` with `requestId` as the current request id. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

/** The current request id, or null outside `runWithRequestId`. */
export function currentRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}
