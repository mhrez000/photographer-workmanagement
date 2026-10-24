"use client";

import * as React from "react";
import { ArrowBigUpDash } from "lucide-react";

/**
 * Caps Lock detection for password fields (docs/ACCOUNTS.md "Sign-in polish"). Wire `onKeyEvent` to BOTH
 * `onKeyDown` and `onKeyUp` of the input; `capsLock` turns true while Caps Lock is on, and false again on blur
 * via `reset` (wire `onBlur`). Browsers only report the state on key events, so it starts false.
 *
 *   const caps = useCapsLock();
 *   <Input onKeyDown={caps.onKeyEvent} onKeyUp={caps.onKeyEvent} onBlur={caps.reset} … />
 *   <CapsLockHint show={caps.capsLock} />
 */
export function useCapsLock(): { capsLock: boolean; onKeyEvent: (event: React.KeyboardEvent) => void; reset: () => void } {
  const [capsLock, setCapsLock] = React.useState(false);
  const onKeyEvent = React.useCallback((event: React.KeyboardEvent) => {
    if (typeof event.getModifierState === "function") setCapsLock(event.getModifierState("CapsLock"));
  }, []);
  const reset = React.useCallback(() => setCapsLock(false), []);
  return { capsLock, onKeyEvent, reset };
}

/** The quiet one-liner under a password field while Caps Lock is on. */
export function CapsLockHint({ show, id }: { show: boolean; id?: string }) {
  if (!show) return null;
  return (
    <p id={id} role="status" className="flex items-center gap-1.5 text-xs text-attention" data-caps-lock-hint="">
      <ArrowBigUpDash aria-hidden="true" className="size-3.5" />
      Caps Lock is on
    </p>
  );
}
