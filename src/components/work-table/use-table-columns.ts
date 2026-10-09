"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import type { JobTableColumn } from "@/lib/constants";
import { parseColumns } from "./columns";

/**
 * Visible columns for a work table. Source of truth is the URL (`?columns=`,
 * so links and saved views carry it); localStorage is the per-browser
 * fallback when the URL has none. Writes use `history.replaceState`, which
 * Next syncs into `useSearchParams` without a server round trip (columns are
 * presentation only).
 */

const CHANGE_EVENT = "work-table:columns-change";

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Private mode / blocked storage: the URL still carries the choice.
  }
}

function subscribe(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  window.addEventListener(CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}

function replaceColumnsParam(value: string | null): void {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete("columns");
  else url.searchParams.set("columns", value);
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

export interface TableColumnsState {
  columns: JobTableColumn[];
  /** Where the current set came from. */
  source: "url" | "stored" | "default";
  /** Replace the visible columns (null = back to the default set). */
  setColumns: (next: readonly JobTableColumn[] | null) => void;
}

/** `enabled = false` (fixed-column tables) skips the URL sync. */
export function useTableColumns(storageKey: string, defaults: readonly JobTableColumn[], enabled = true): TableColumnsState {
  const searchParams = useSearchParams();
  const urlColumns = parseColumns(searchParams?.get("columns"));
  const stored = React.useSyncExternalStore(
    subscribe,
    () => readStored(storageKey),
    () => null,
  );
  const storedColumns = parseColumns(stored);

  // A remembered set with no ?columns= yet: put it in the URL so saved views
  // and shared links see what is on screen.
  const syncValue = enabled && !urlColumns && storedColumns ? storedColumns.join(",") : null;
  React.useEffect(() => {
    if (syncValue) replaceColumnsParam(syncValue);
  }, [syncValue]);

  const setColumns = React.useCallback(
    (next: readonly JobTableColumn[] | null) => {
      const value = next && next.length > 0 ? next.join(",") : null;
      writeStored(storageKey, value);
      replaceColumnsParam(value);
      window.dispatchEvent(new Event(CHANGE_EVENT));
    },
    [storageKey],
  );

  const columns = urlColumns ?? storedColumns ?? [...defaults];
  const source = urlColumns ? "url" : storedColumns ? "stored" : "default";
  return { columns, source, setColumns };
}
