"use client";

import * as React from "react";

/**
 * A shared ticking clock for live durations (running timers, "time in
 * status"). One interval per tick size is shared by every subscriber.
 * Returns `null` during server rendering and hydration so markup never
 * mismatches; render a static fallback in that case.
 */

interface Ticker {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  subscribe: (listener: () => void) => () => void;
}

const tickers = new Map<number, Ticker>();

function tickerFor(intervalMs: number): Ticker {
  const existing = tickers.get(intervalMs);
  if (existing) return existing;
  const ticker: Ticker = {
    now: Date.now(),
    listeners: new Set(),
    timer: null,
    subscribe: (listener) => {
      ticker.listeners.add(listener);
      if (ticker.timer === null) {
        ticker.now = Date.now();
        ticker.timer = setInterval(() => {
          ticker.now = Date.now();
          ticker.listeners.forEach((l) => l());
        }, intervalMs);
      }
      return () => {
        ticker.listeners.delete(listener);
        if (ticker.listeners.size === 0 && ticker.timer !== null) {
          clearInterval(ticker.timer);
          ticker.timer = null;
        }
      };
    },
  };
  tickers.set(intervalMs, ticker);
  return ticker;
}

const serverSnapshot = () => null;

/** Current epoch ms, updated every `intervalMs` (null on the server / first paint). */
export function useNow(intervalMs = 1000): number | null {
  const ticker = tickerFor(intervalMs);
  return React.useSyncExternalStore(ticker.subscribe, () => ticker.now, serverSnapshot);
}
