import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import type { CSSProperties } from "react";

/**
 * tailwind-merge instance that knows about the Proofline token names
 * declared in `src/app/globals.css`, so conflicting utilities resolve
 * correctly (e.g. `cn("shadow-sm", "shadow-pop")` keeps `shadow-pop`).
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      shadow: [{ shadow: ["xs", "sm", "md", "pop"] }],
      "font-size": [{ text: ["2xs", "md"] }],
      animate: [
        {
          animate: [
            "fade-in",
            "fade-out",
            "slide-up",
            "slide-down",
            "slide-in-right",
            "slide-in-left",
            "slide-in-bottom",
            "scale-in",
            "pop-in",
            "shimmer",
            "spin-slow",
          ],
        },
      ],
      rounded: [{ rounded: ["xs", "sm", "md", "lg", "xl", "2xl"] }],
    },
  },
});

/** Merge class names with Tailwind conflict resolution. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** React style object that also accepts CSS custom properties. */
export type CSSVariables = CSSProperties & {
  [key: `--${string}`]: string | number;
};

/**
 * Initials from a display name: "Sarah Jane Cole" → "SC", "sarah" → "S".
 * Falls back to "?" for empty input.
 */
export function initials(name: string | null | undefined, max = 2): string {
  const parts = (name ?? "")
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, max).toUpperCase();
  const first = parts[0][0] ?? "";
  const last = parts[parts.length - 1][0] ?? "";
  return (first + last).slice(0, max).toUpperCase();
}

/** Small, stable 32-bit string hash (FNV-1a). */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic hue (0–359) for a string — used for avatar tints so the
 * same person always gets the same colour. Hues are spread across 12
 * evenly spaced, pleasant stops rather than the full wheel to avoid muddy
 * yellows/greens.
 */
const AVATAR_HUES = [16, 36, 58, 92, 150, 176, 198, 224, 258, 286, 318, 344] as const;

export function hueFromString(input: string): number {
  return AVATAR_HUES[hashString(input) % AVATAR_HUES.length];
}

/** Clamp a number into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Truncate a string with an ellipsis. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** "1 job" / "3 jobs" — with an optional irregular plural. */
export function pluralise(count: number, singular: string, plural?: string): string {
  const word = count === 1 ? singular : (plural ?? `${singular}s`);
  return `${count.toLocaleString("en-AU")} ${word}`;
}

/** Format a number with thin, locale-aware grouping (data tables). */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat("en-AU", options).format(value);
}

/** Percentage with no fractional digits by default: 0.734 → "73%". */
export function formatPercent(ratio: number, digits = 0): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** URL-safe slug. */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Inclusive integer range helper for skeletons and demo data. */
export function range(length: number): number[] {
  return Array.from({ length }, (_, i) => i);
}

/** Type guard: value is neither null nor undefined. */
export function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/** Capitalise the first character. */
export function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** "in-progress" → "In progress", "stalledDays" → "Stalled days" (for displaying enum-like / field keys). */
export function humanise(key: string): string {
  return capitalise(
    key
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[-_]+/g, " ")
      .trim()
      .toLowerCase(),
  );
}

/** Detect Apple platforms on the client for ⌘ vs Ctrl hints. Safe on server. */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? "") || /Mac OS X/.test(navigator.userAgent ?? "");
}

/** Safe localStorage read (SSR + privacy modes). */
export function readStorage(key: string): string | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Safe localStorage write (SSR + privacy modes). */
export function writeStorage(key: string, value: string): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, value);
  } catch {
    // Storage may be unavailable (private mode, quota, disabled). Ignore.
  }
}
