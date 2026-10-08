"use client";

import * as React from "react";
import { isApplePlatform, readStorage, writeStorage } from "@/lib/utils";
import { SIDEBAR_STORAGE_KEY } from "./types";

/* Sidebar collapsed state — persisted in localStorage, hydration-safe via
   useSyncExternalStore (server snapshot = expanded). Falls back to memory
   when storage is unavailable. */

const listeners = new Set<() => void>();
let memoryValue: boolean | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === SIDEBAR_STORAGE_KEY) {
      memoryValue = null;
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): boolean {
  if (memoryValue !== null) return memoryValue;
  return readStorage(SIDEBAR_STORAGE_KEY) === "1";
}

function getServerSnapshot(): boolean {
  return false;
}

export function useSidebarCollapsed(): [boolean, () => void] {
  const collapsed = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggle = React.useCallback(() => {
    const next = !getSnapshot();
    memoryValue = next;
    writeStorage(SIDEBAR_STORAGE_KEY, next ? "1" : "0");
    listeners.forEach((listener) => listener());
  }, []);

  return [collapsed, toggle];
}

/* Platform hint for ⌘ vs Ctrl — false on the server, real value after hydration. */

function noopSubscribe() {
  return () => {};
}

export function useIsMac(): boolean {
  return React.useSyncExternalStore(noopSubscribe, isApplePlatform, () => false);
}
