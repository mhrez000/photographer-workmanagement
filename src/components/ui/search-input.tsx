"use client";

import * as React from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input, type InputProps } from "./input";
import { Kbd } from "./kbd";

export interface SearchInputProps extends Omit<InputProps, "onChange" | "value" | "defaultValue" | "type" | "leading" | "trailing"> {
  value?: string;
  defaultValue?: string;
  /** Fires with the raw string on every keystroke. */
  onValueChange?: (value: string) => void;
  /** Debounced version of `onValueChange` (ms). */
  debounce?: number;
  onDebouncedChange?: (value: string) => void;
  /** Clear button / Escape also calls this. */
  onClear?: () => void;
  /** Shortcut hint rendered on the right when empty (e.g. "/"). */
  shortcut?: string;
}

/** Search field with icon, clear button, Escape-to-clear and optional debounce. */
export function SearchInput({
  value,
  defaultValue = "",
  onValueChange,
  debounce = 250,
  onDebouncedChange,
  onClear,
  shortcut,
  placeholder = "Search…",
  className,
  onKeyDown,
  ref,
  ...props
}: SearchInputProps) {
  const [internal, setInternal] = React.useState(defaultValue);
  const isControlled = value !== undefined;
  const current = isControlled ? value : internal;
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const setRefs = React.useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  const onDebouncedRef = React.useRef(onDebouncedChange);
  React.useEffect(() => {
    onDebouncedRef.current = onDebouncedChange;
  });

  React.useEffect(() => {
    if (!onDebouncedRef.current) return;
    const timer = window.setTimeout(() => onDebouncedRef.current?.(current), debounce);
    return () => window.clearTimeout(timer);
  }, [current, debounce]);

  const update = (next: string) => {
    if (!isControlled) setInternal(next);
    onValueChange?.(next);
  };

  const clear = () => {
    update("");
    onClear?.();
    inputRef.current?.focus();
  };

  return (
    <Input
      ref={setRefs}
      type="search"
      role="searchbox"
      value={current}
      placeholder={placeholder}
      onChange={(event) => update(event.target.value)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === "Escape" && current) {
          event.preventDefault();
          clear();
        }
      }}
      leading={<Search aria-hidden="true" />}
      trailing={
        current ? (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear search"
            className="pointer-events-auto -mr-1 flex size-6 items-center justify-center rounded-xs text-ink-subtle hover:bg-surface-muted hover:text-ink focus-ring"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        ) : shortcut ? (
          <Kbd className="pointer-events-none">{shortcut}</Kbd>
        ) : undefined
      }
      className={cn(className)}
      {...props}
    />
  );
}
