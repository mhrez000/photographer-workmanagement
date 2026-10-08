"use client";

import * as React from "react";
import { useLatest } from "./use-dismissable";

let scrollLocks = 0;
let previousOverflow = "";

/* Lock on <body>, not <html>: hiding overflow on the root element stops
   `position: sticky` headers from sticking in Chromium. */
function lockScroll() {
  if (typeof document === "undefined") return;
  if (scrollLocks === 0) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  scrollLocks += 1;
}

function unlockScroll() {
  if (typeof document === "undefined") return;
  scrollLocks = Math.max(0, scrollLocks - 1);
  if (scrollLocks === 0) {
    document.body.style.overflow = previousOverflow;
  }
}

export interface UseModalDialogOptions {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Allow Escape / backdrop click to close. */
  dismissible?: boolean;
}

/**
 * Syncs a native `<dialog>` with React state (`showModal()` / `close()`),
 * locks page scroll while open, and returns handlers for Escape (cancel),
 * backdrop clicks and the native close event.
 */
export function useModalDialog({ open, onOpenChange, dismissible = true }: UseModalDialogOptions) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const onOpenChangeRef = useLatest(onOpenChange);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) {
      if (!el.open) el.showModal();
      lockScroll();
      return () => {
        unlockScroll();
      };
    }
    if (el.open) el.close();
    return undefined;
  }, [open]);

  const handleCancel = React.useCallback(
    (event: React.SyntheticEvent<HTMLDialogElement>) => {
      event.preventDefault();
      if (dismissible) onOpenChangeRef.current(false);
    },
    [dismissible, onOpenChangeRef],
  );

  const handleClose = React.useCallback(() => {
    // Fired after el.close(); make sure React state agrees (e.g. form method="dialog").
    onOpenChangeRef.current(false);
  }, [onOpenChangeRef]);

  const handleBackdropClick = React.useCallback(
    (event: React.MouseEvent<HTMLDialogElement>) => {
      if (!dismissible) return;
      if (event.target === event.currentTarget) onOpenChangeRef.current(false);
    },
    [dismissible, onOpenChangeRef],
  );

  const close = React.useCallback(() => onOpenChangeRef.current(false), [onOpenChangeRef]);

  return { ref, handleCancel, handleClose, handleBackdropClick, close };
}
