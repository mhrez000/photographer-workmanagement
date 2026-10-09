"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * URL search params as UI state (filters, sort, tabs, ranges) — shareable and
 * restored on reload. Writes use `router.replace(…, { scroll: false })` inside
 * a transition, so the server component re-renders with the new params while
 * `isPending` drives a subtle loading hint.
 *
 * Multi-value params are written comma-joined (`?statusCategory=review,revision`);
 * `getAll` reads both comma lists and repeated keys, matching `params()` in
 * src/server/page.ts and the list schemas in src/server/queries.
 */

export type UrlValue = string | number | boolean | readonly string[] | null | undefined;

export interface UseUrlStateOptions {
  /** Params dropped whenever anything else changes (pagination). Default ["cursor"]. */
  resetKeys?: readonly string[];
}

export interface UrlState {
  /** Current params (read-only snapshot). */
  params: URLSearchParams;
  get: (key: string) => string | null;
  getAll: (key: string) => string[];
  has: (key: string) => boolean;
  /** Set one key (null / "" / [] / false removes it). */
  set: (key: string, value: UrlValue) => void;
  /** Set several keys at once. */
  patch: (values: Record<string, UrlValue>) => void;
  /** Remove the given keys (every key when omitted). */
  clear: (keys?: readonly string[]) => void;
  /** Replace the whole query string. */
  replaceAll: (values: Record<string, UrlValue>) => void;
  /** Href for the current path with `values` patched in (for links). */
  hrefWith: (values: Record<string, UrlValue>) => string;
  isPending: boolean;
}

/** Splits comma lists and repeated keys into one array. */
export function splitParamValues(raw: readonly string[]): string[] {
  return raw.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
}

function applyValue(next: URLSearchParams, key: string, value: UrlValue): void {
  next.delete(key);
  if (value === null || value === undefined || value === "" || value === false) return;
  if (Array.isArray(value)) {
    const list = (value as readonly string[]).filter((v) => v !== "");
    if (list.length > 0) next.set(key, list.join(","));
    return;
  }
  next.set(key, value === true ? "1" : String(value));
}

/** Read/write URL search params as component state. */
export function useUrlState(options: UseUrlStateOptions = {}): UrlState {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = React.useTransition();
  const resetSignature = (options.resetKeys ?? ["cursor"]).join(",");

  const current = React.useMemo(() => new URLSearchParams(searchParams?.toString() ?? ""), [searchParams]);

  const build = React.useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(current.toString());
      mutate(next);
      for (const key of resetSignature.split(",").filter(Boolean)) next.delete(key);
      const qs = next.toString();
      return qs ? `${pathname}?${qs}` : pathname;
    },
    [current, pathname, resetSignature],
  );

  const navigate = React.useCallback(
    (href: string) => {
      startTransition(() => {
        router.replace(href, { scroll: false });
      });
    },
    [router],
  );

  return React.useMemo<UrlState>(
    () => ({
      params: current,
      get: (key) => current.get(key),
      getAll: (key) => splitParamValues(current.getAll(key)),
      has: (key) => current.has(key),
      set: (key, value) => navigate(build((next) => applyValue(next, key, value))),
      patch: (values) =>
        navigate(
          build((next) => {
            for (const [key, value] of Object.entries(values)) applyValue(next, key, value);
          }),
        ),
      clear: (keys) =>
        navigate(
          build((next) => {
            const targets = keys ?? Array.from(next.keys());
            for (const key of targets) next.delete(key);
          }),
        ),
      replaceAll: (values) =>
        navigate(
          build((next) => {
            for (const key of Array.from(next.keys())) next.delete(key);
            for (const [key, value] of Object.entries(values)) applyValue(next, key, value);
          }),
        ),
      hrefWith: (values) =>
        build((next) => {
          for (const [key, value] of Object.entries(values)) applyValue(next, key, value);
        }),
      isPending,
    }),
    [current, build, navigate, isPending],
  );
}
