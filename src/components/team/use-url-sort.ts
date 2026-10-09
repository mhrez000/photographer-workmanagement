"use client";

import type { SortDirection } from "@/components/ui/table";
import { useUrlState } from "@/hooks/use-url-state";

/**
 * Column sort kept in the URL (`?<prefix>sort=key&<prefix>dir=asc|desc`) so
 * a sorted table can be shared. Each column has a natural first direction.
 */
export function useUrlSort<K extends string>(prefix: string, firstDir: Record<K, "asc" | "desc">, fallback: K) {
  const url = useUrlState();
  const keys = Object.keys(firstDir) as K[];
  const raw = url.get(`${prefix}sort`) as K | null;
  const key: K = raw && keys.includes(raw) ? raw : fallback;
  const rawDir = url.get(`${prefix}dir`);
  const dir: "asc" | "desc" = rawDir === "asc" || rawDir === "desc" ? rawDir : firstDir[key];

  const directionOf = (k: K): SortDirection => (k === key ? dir : null);
  const toggle = (k: K) => () => {
    const next = k === key ? (dir === "asc" ? "desc" : "asc") : firstDir[k];
    url.patch({
      [`${prefix}sort`]: k === fallback && next === firstDir[k] ? null : k,
      [`${prefix}dir`]: next === firstDir[k] ? null : next,
    });
  };

  /** Sorts with nulls last regardless of direction. */
  function sortRows<T>(rows: readonly T[], value: (row: T, k: K) => number | string | null, tiebreak: (row: T) => string): T[] {
    return [...rows].sort((a, b) => {
      const av = value(a, key);
      const bv = value(b, key);
      if (av === null && bv === null) return tiebreak(a).localeCompare(tiebreak(b));
      if (av === null) return 1;
      if (bv === null) return -1;
      const c = typeof av === "string" ? av.localeCompare(String(bv)) : av - (bv as number);
      return (dir === "asc" ? c : -c) || tiebreak(a).localeCompare(tiebreak(b));
    });
  }

  return { key, dir, directionOf, toggle, sortRows };
}
