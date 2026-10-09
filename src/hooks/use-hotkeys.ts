"use client";

import * as React from "react";

/**
 * Keyboard shortcuts (spec §26, `KEYBOARD_SHORTCUTS` in src/lib/constants.ts).
 *
 * Binding syntax:
 *   "n", "?", "/", "esc", "enter"      single keys
 *   "mod+k", "shift+enter", "alt+1"     chords (`mod` = ⌘ on Apple, Ctrl elsewhere)
 *   "g d"                               two-step sequences (second key within 1 s)
 *
 * Keystrokes typed into inputs, textareas, selects and contenteditable
 * regions are ignored (except chords using mod/ctrl/alt, or with
 * `allowInInputs`). While a modal `<dialog>` is open, non-chord shortcuts are
 * ignored too, so typing "g d" inside a dialog never navigates away.
 */

export type HotkeyHandler = (event: KeyboardEvent) => void;
export type HotkeyMap = Record<string, HotkeyHandler>;

export interface UseHotkeysOptions {
  /** Turn every binding off (e.g. while a panel is closed). Default true. */
  enabled?: boolean;
  /** Also fire while focus is in a text field. Default false. */
  allowInInputs?: boolean;
  /** Also fire while a modal dialog is open. Default false. */
  allowInDialogs?: boolean;
  /** Call `preventDefault()` when a binding fires. Default true. */
  preventDefault?: boolean;
}

const SEQUENCE_TIMEOUT_MS = 1000;

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  return: "enter",
  space: " ",
  spacebar: " ",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  del: "delete",
};

interface Chord {
  key: string;
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  /** null = do not care (symbols like "?" already imply shift). */
  shift: boolean | null;
}

function isApple(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? "") || /Mac OS X/.test(navigator.userAgent ?? "");
}

function parseChord(spec: string): Chord {
  const parts = spec.toLowerCase().split("+").map((p) => p.trim());
  const rawKey = parts.pop() ?? "";
  // A literal "+" key is bound as "plus".
  const key = rawKey === "plus" ? "+" : (KEY_ALIASES[rawKey] ?? rawKey);
  const has = (m: string) => parts.includes(m);
  const isLetterOrNamed = /^[a-z0-9]$/.test(key) || key.length > 1;
  return {
    key,
    mod: has("mod"),
    ctrl: has("ctrl"),
    meta: has("meta") || has("cmd"),
    alt: has("alt") || has("option"),
    shift: has("shift") ? true : isLetterOrNamed ? false : null,
  };
}

function eventKey(event: KeyboardEvent): string {
  const key = (event.key ?? "").toLowerCase();
  return KEY_ALIASES[key] ?? key;
}

function chordMatches(chord: Chord, event: KeyboardEvent, apple: boolean): boolean {
  if (eventKey(event) !== chord.key) return false;
  const wantMeta = chord.meta || (chord.mod && apple);
  const wantCtrl = chord.ctrl || (chord.mod && !apple);
  if (event.metaKey !== wantMeta) return false;
  if (event.ctrlKey !== wantCtrl) return false;
  if (event.altKey !== chord.alt) return false;
  if (chord.shift !== null && event.shiftKey !== chord.shift) return false;
  return true;
}

/** True when the event target is a field the user is typing into. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type);
  }
  return target.closest("[role='textbox'], [role='combobox']") !== null;
}

function modalOpen(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector("dialog[open]") !== null;
}

interface ParsedBinding {
  steps: Chord[];
  spec: string;
}

/** Register global keyboard shortcuts for the lifetime of the component. */
export function useHotkeys(bindings: HotkeyMap, options: UseHotkeysOptions = {}): void {
  const { enabled = true, allowInInputs = false, allowInDialogs = false, preventDefault = true } = options;

  // Latest handlers without re-subscribing on every render.
  const bindingsRef = React.useRef(bindings);
  React.useEffect(() => {
    bindingsRef.current = bindings;
  });

  const signature = Object.keys(bindings).sort().join("|");

  React.useEffect(() => {
    if (!enabled) return undefined;
    const apple = isApple();
    const parsed: ParsedBinding[] = signature
      .split("|")
      .filter(Boolean)
      .map((spec) => ({ steps: spec.trim().split(/\s+/).map(parseChord), spec }));

    let pending: { spec: string; at: number }[] = [];

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if (["shift", "control", "alt", "meta"].includes(eventKey(event))) return;
      const isChord = event.metaKey || event.ctrlKey || event.altKey;
      if (!isChord && !allowInInputs && isTypingTarget(event.target)) return;
      if (!isChord && !allowInDialogs && modalOpen()) return;

      const now = Date.now();
      const fire = (spec: string) => {
        const handler = bindingsRef.current[spec];
        if (!handler) return false;
        if (preventDefault) event.preventDefault();
        handler(event);
        return true;
      };

      // Second step of a sequence?
      const live = pending.filter((p) => now - p.at <= SEQUENCE_TIMEOUT_MS);
      pending = [];
      for (const binding of parsed) {
        if (binding.steps.length !== 2) continue;
        if (live.some((p) => p.spec === binding.spec) && chordMatches(binding.steps[1], event, apple)) {
          if (fire(binding.spec)) return;
        }
      }

      // First step of a sequence: remember it.
      const starts = parsed.filter((b) => b.steps.length === 2 && chordMatches(b.steps[0], event, apple));
      if (starts.length > 0) {
        pending = starts.map((b) => ({ spec: b.spec, at: now }));
        return;
      }

      for (const binding of parsed) {
        if (binding.steps.length === 1 && chordMatches(binding.steps[0], event, apple)) {
          if (fire(binding.spec)) return;
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, allowInInputs, allowInDialogs, preventDefault, signature]);
}

/** Display form of a binding: "mod+k" → ["⌘", "K"] (or ["Ctrl", "K"]); "g d" → ["G", "D"]. */
export function formatHotkey(spec: string, apple = isApple()): string[] {
  return spec
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((step) =>
      step.split("+").map((part) => {
        const p = part.toLowerCase();
        if (p === "mod") return apple ? "⌘" : "Ctrl";
        if (p === "shift") return apple ? "⇧" : "Shift";
        if (p === "alt" || p === "option") return apple ? "⌥" : "Alt";
        if (p === "ctrl") return "Ctrl";
        if (p === "meta" || p === "cmd") return "⌘";
        if (p === "enter") return "↵";
        if (p === "esc" || p === "escape") return "Esc";
        return part.length === 1 ? part.toUpperCase() : part;
      }),
    );
}
