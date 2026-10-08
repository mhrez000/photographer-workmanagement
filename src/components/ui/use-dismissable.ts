"use client";

import * as React from "react";

export interface UseDismissableOptions {
  /** Whether the layer is currently open. */
  open: boolean;
  /** Called when the user clicks outside or presses Escape. */
  onDismiss: () => void;
  /** Elements that count as "inside" (the layer and its trigger). */
  refs: React.RefObject<HTMLElement | null>[];
  /** Disable the outside-click behaviour. */
  disableOutsideClick?: boolean;
  /** Disable the Escape behaviour. */
  disableEscape?: boolean;
}

/** Keeps a ref pointing at the latest value without reading refs during render. */
export function useLatest<T>(value: T): React.RefObject<T> {
  const ref = React.useRef(value);
  React.useEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * Close a floating layer on outside pointer-down or Escape.
 * Shared by DropdownMenu and Popover.
 */
export function useDismissable({
  open,
  onDismiss,
  refs,
  disableOutsideClick = false,
  disableEscape = false,
}: UseDismissableOptions): void {
  const onDismissRef = useLatest(onDismiss);
  const refsRef = useLatest(refs);

  React.useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (disableOutsideClick) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      const inside = refsRef.current.some((ref) => ref.current?.contains(target));
      if (!inside) onDismissRef.current();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (disableEscape) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        onDismissRef.current();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, disableOutsideClick, disableEscape, onDismissRef, refsRef]);
}

/**
 * Controlled/uncontrolled open state helper.
 */
export function useControllableOpen(
  open: boolean | undefined,
  defaultOpen: boolean,
  onOpenChange: ((open: boolean) => void) | undefined,
): [boolean, (next: boolean) => void] {
  const [internal, setInternal] = React.useState(defaultOpen);
  const isControlled = open !== undefined;
  const value = isControlled ? open : internal;
  const onOpenChangeRef = useLatest(onOpenChange);

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setInternal(next);
      onOpenChangeRef.current?.(next);
    },
    [isControlled, onOpenChangeRef],
  );

  return [value, setOpen];
}

/**
 * On mount, measures the floating element and writes `data-side` on it so
 * CSS can flip it to the opposite side when it would overflow the viewport.
 * The element should render with `data-side={preferred}` and style both
 * placements via `data-[side=top]:` / `data-[side=bottom]:` variants.
 */
export function useAutoFlip(ref: React.RefObject<HTMLElement | null>, preferred: "top" | "bottom"): void {
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.dataset.side = preferred;
    const rect = el.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    if (preferred === "bottom" && rect.bottom > viewportHeight - 8 && rect.top > rect.height + 8) {
      el.dataset.side = "top";
    } else if (preferred === "top" && rect.top < 8 && rect.bottom + rect.height + 8 < viewportHeight) {
      el.dataset.side = "bottom";
    }
  }, [ref, preferred]);
}

/** Roving focus for menus/lists: moves focus between focusable items. */
export function moveFocus(
  container: HTMLElement | null,
  selector: string,
  direction: "next" | "prev" | "first" | "last",
): void {
  if (!container) return;
  const items = Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true",
  );
  if (items.length === 0) return;
  const active = document.activeElement;
  const index = items.findIndex((el) => el === active);
  let next = 0;
  if (direction === "first") next = 0;
  else if (direction === "last") next = items.length - 1;
  else if (direction === "next") next = index < 0 ? 0 : (index + 1) % items.length;
  else next = index <= 0 ? items.length - 1 : index - 1;
  items[next]?.focus();
}
