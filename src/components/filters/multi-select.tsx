"use client";

import * as React from "react";
import { Check, ChevronDown, Search, type LucideIcon } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export interface MultiSelectOption {
  value: string;
  label: string;
  /** Secondary line (client of a project, role…). */
  description?: string;
  /** Colour dot (status / priority / job type). */
  colour?: string;
  /** Show an avatar (people). */
  avatar?: { name: string; colour?: string | null };
  /** Trailing count ("12"). */
  count?: number;
}

export interface MultiSelectProps {
  /** Facet name shown on the trigger ("Editor", "Status"). */
  label: string;
  options: MultiSelectOption[];
  value: string[];
  onChange: (next: string[]) => void;
  icon?: LucideIcon;
  /** Show the search box (default: more than 7 options). */
  searchable?: boolean;
  loading?: boolean;
  /** Called the first time the popover opens (lazy-load options). */
  onOpen?: () => void;
  emptyText?: string;
  align?: "start" | "end";
  /** Single-choice mode (still renders checkmarks; picking replaces). */
  single?: boolean;
  className?: string;
}

/**
 * Filter facet: a trigger showing the selection, opening a searchable
 * checklist. Arrow keys move between options, Space/Enter toggles.
 */
export function MultiSelect({
  label,
  options,
  value,
  onChange,
  icon: Icon,
  searchable,
  loading = false,
  onOpen,
  emptyText = "Nothing to choose from yet.",
  align = "start",
  single = false,
  className,
}: MultiSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const listRef = React.useRef<HTMLDivElement>(null);
  const selected = new Set(value);
  const showSearch = searchable ?? options.length > 7;

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) onOpen?.();
    else setQuery("");
  };

  const q = query.trim().toLowerCase();
  const visible = q ? options.filter((o) => o.label.toLowerCase().includes(q) || o.description?.toLowerCase().includes(q)) : options;

  const toggle = (v: string) => {
    if (single) {
      onChange(selected.has(v) ? [] : [v]);
      return;
    }
    onChange(selected.has(v) ? value.filter((x) => x !== v) : [...value, v]);
  };

  const firstSelected = options.find((o) => selected.has(o.value));
  const triggerText =
    value.length === 0 ? label : value.length === 1 && firstSelected ? firstSelected.label : label;

  const onListKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? []);
    if (items.length === 0) return;
    const index = items.findIndex((el) => el === document.activeElement);
    let next = 0;
    if (event.key === "End") next = items.length - 1;
    else if (event.key === "ArrowDown") next = index < 0 ? 0 : (index + 1) % items.length;
    else if (event.key === "ArrowUp") next = index <= 0 ? items.length - 1 : index - 1;
    items[next]?.focus();
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange} className={className}>
      <PopoverTrigger
        variant="outline"
        size="sm"
        aria-label={value.length > 0 ? `${label}: ${value.length} selected` : `Filter by ${label.toLowerCase()}`}
        className={cn(
          "max-w-56 gap-1.5 font-normal",
          value.length > 0 && "border-accent/40 bg-accent-soft/50 text-accent-ink hover:bg-accent-soft",
        )}
      >
        {Icon ? <Icon aria-hidden="true" className="text-current opacity-70" /> : null}
        <span className="truncate">
          {value.length === 1 && firstSelected ? (
            <>
              <span className="text-ink-muted">{label}: </span>
              {triggerText}
            </>
          ) : (
            triggerText
          )}
        </span>
        {value.length > 1 ? (
          <span className="numeric inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-2xs font-semibold text-accent-fg">
            {value.length}
          </span>
        ) : null}
        <ChevronDown aria-hidden="true" className="opacity-60" />
      </PopoverTrigger>
      <PopoverContent align={align} aria-label={`${label} filter`} className="w-[min(18rem,calc(100vw-2rem))] p-0">
        {showSearch ? (
          <div className="border-b border-border p-2">
            <label className="relative block">
              <span className="sr-only">Search {label.toLowerCase()}</span>
              <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-subtle" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    listRef.current?.querySelector<HTMLButtonElement>("[role=option]")?.focus();
                  }
                }}
                placeholder={`Search ${label.toLowerCase()}…`}
                className="h-8 w-full rounded-sm border border-border bg-surface pl-8 pr-2 text-sm text-ink placeholder:text-ink-subtle pointer-coarse:text-touch max-sm:text-touch focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
              />
            </label>
          </div>
        ) : null}
        <div
          ref={listRef}
          role="listbox"
          aria-multiselectable={!single}
          aria-label={label}
          onKeyDown={onListKeyDown}
          className="max-h-72 overflow-y-auto p-1 scrollbar-thin"
        >
          {loading && options.length === 0 ? (
            <div className="flex items-center gap-2 px-2.5 py-3 text-sm text-ink-muted">
              <Spinner size="xs" /> Loading…
            </div>
          ) : visible.length === 0 ? (
            <p className="px-2.5 py-3 text-sm text-ink-muted">{q ? `No matches for “${query}”.` : emptyText}</p>
          ) : (
            visible.map((o) => {
              const isOn = selected.has(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={isOn}
                  onClick={() => toggle(o.value)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors",
                    "hover:bg-surface-muted focus-visible:bg-surface-muted",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-xs border transition-colors",
                      isOn ? "border-accent bg-accent text-accent-fg" : "border-border-strong bg-surface",
                    )}
                  >
                    {isOn ? <Check className="size-3" strokeWidth={3} /> : null}
                  </span>
                  {o.avatar ? <Avatar name={o.avatar.name} colour={o.avatar.colour || undefined} size="xs" /> : null}
                  {o.colour && !o.avatar ? (
                    <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: o.colour }} />
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ink">{o.label}</span>
                    {o.description ? <span className="block truncate text-xs text-ink-muted">{o.description}</span> : null}
                  </span>
                  {o.count !== undefined ? <span className="numeric text-xs text-ink-subtle">{o.count}</span> : null}
                </button>
              );
            })
          )}
        </div>
        {value.length > 0 ? (
          <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs">
            <span className="text-ink-muted numeric">{value.length} selected</span>
            <button type="button" onClick={() => onChange([])} className="font-medium text-accent-ink hover:underline focus-ring rounded-xs">
              Clear
            </button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
