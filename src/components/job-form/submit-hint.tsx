"use client";

import * as React from "react";
import { Kbd } from "@/components/ui/kbd";
import { isApplePlatform } from "@/lib/utils";

const subscribe = () => () => {};

/** "⌘ ↵ to save" / "Ctrl ↵ to save" — platform resolved after hydration. */
export function SubmitHint({ action = "save", className }: { action?: string; className?: string }) {
  const apple = React.useSyncExternalStore(subscribe, isApplePlatform, () => false);
  return (
    <span className={className}>
      <span className="hidden items-center gap-1.5 text-xs text-ink-subtle md:inline-flex">
        <Kbd keys={[apple ? "⌘" : "Ctrl", "↵"]} />
        to {action}
      </span>
    </span>
  );
}

/**
 * Keyboard behaviour for long forms: ⌘/Ctrl+Enter submits from anywhere; a
 * plain Enter inside a single-line input does NOT submit (avoids accidental
 * half-filled submissions). Attach to the form's onKeyDown.
 */
export function formKeyDown(event: React.KeyboardEvent<HTMLFormElement>): void {
  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
  if (event.metaKey || event.ctrlKey) {
    event.preventDefault();
    event.currentTarget.requestSubmit();
    return;
  }
  const target = event.target as HTMLElement;
  if (target instanceof HTMLInputElement && !["checkbox", "radio", "submit", "button"].includes(target.type)) {
    event.preventDefault();
  }
}

/** Warns before leaving the page while `dirty` (browser-native prompt). */
export function useUnsavedChangesWarning(dirty: boolean): void {
  React.useEffect(() => {
    if (!dirty) return undefined;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
}
