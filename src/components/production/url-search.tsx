"use client";

import * as React from "react";
import { SearchInput } from "@/components/ui/search-input";
import { Spinner } from "@/components/ui/spinner";
import { useUrlState } from "@/hooks/use-url-state";
import { cn } from "@/lib/utils";

export interface UrlSearchInputProps {
  /** URL key (default "q"). */
  param?: string;
  placeholder?: string;
  label?: string;
  autoFocus?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
  /** Shortcut hint shown when empty. */
  shortcut?: string;
}

/** Debounced search box whose value lives in the URL (shareable, survives reload). */
export function UrlSearchInput({ param = "q", placeholder = "Search…", label, autoFocus, size = "md", className, shortcut }: UrlSearchInputProps) {
  const url = useUrlState();
  const urlValue = url.get(param) ?? "";
  const [value, setValue] = React.useState(urlValue);
  const lastUrl = React.useRef(urlValue);

  // Follow back/forward navigation without clobbering what the user is typing.
  React.useEffect(() => {
    if (urlValue !== lastUrl.current) {
      lastUrl.current = urlValue;
      setValue(urlValue);
    }
  }, [urlValue]);

  const commit = (next: string) => {
    const trimmed = next.trim();
    if (trimmed === (url.get(param) ?? "")) return;
    lastUrl.current = trimmed;
    url.set(param, trimmed || null);
  };

  return (
    <div className={cn("relative", className)}>
      <SearchInput
        value={value}
        onValueChange={setValue}
        onDebouncedChange={commit}
        onClear={() => commit("")}
        debounce={300}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        autoFocus={autoFocus}
        size={size}
        shortcut={shortcut}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(value);
        }}
      />
      {url.isPending ? (
        <span className="pointer-events-none absolute right-9 top-1/2 -translate-y-1/2 text-ink-subtle">
          <Spinner size="xs" label="Searching" />
        </span>
      ) : null}
    </div>
  );
}
