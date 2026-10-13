"use client";

import * as React from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger, usePopover } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export interface ComboboxOption {
  value: string;
  label: string;
  /** Secondary line (client of a project, workload…). */
  description?: string;
  /** Extra words matched by the search box. */
  keywords?: string;
  /** Leading visual (colour dot, avatar). */
  leading?: React.ReactNode;
  /** Trailing visual (workload band, count). */
  trailing?: React.ReactNode;
  disabled?: boolean;
}

export interface ComboboxProps {
  id?: string;
  options: ComboboxOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: React.ReactNode;
  loading?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  /** Offer a "None" row that clears the value. */
  clearLabel?: string;
  /** Pinned row under the list (e.g. "+ New client"). Receives the current query. */
  footer?: (query: string, close: () => void) => React.ReactNode;
  /** Fires when the panel opens (lazy loading). */
  onOpen?: () => void;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
  "aria-label"?: string;
  className?: string;
}

function matches(option: ComboboxOption, query: string): boolean {
  if (!query) return true;
  const hay = `${option.label} ${option.description ?? ""} ${option.keywords ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

/**
 * Searchable single-select for forms: an input-styled trigger opening a
 * panel with a search box and a keyboard-navigable listbox (↑/↓, Enter,
 * Esc). Options are filtered locally.
 */
export function Combobox(props: ComboboxProps) {
  const { id, options, value, placeholder = "Select…", disabled, invalid, className, onOpen } = props;
  const selected = options.find((o) => o.value === value) ?? null;
  const [open, setOpen] = React.useState(false);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onOpen?.();
      }}
      className={cn("flex w-full", className)}
    >
      <PopoverTrigger
        id={id}
        variant="outline"
        disabled={disabled}
        aria-describedby={props["aria-describedby"]}
        aria-invalid={invalid || props["aria-invalid"] || undefined}
        aria-required={props["aria-required"]}
        aria-label={props["aria-label"]}
        className={cn(
          "h-9 w-full justify-between gap-2 px-3 font-normal",
          "aria-invalid:border-danger",
          !selected && "text-ink-subtle",
        )}
        trailingIcon={<ChevronsUpDown aria-hidden="true" className="text-ink-subtle" />}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {selected?.leading}
          <span className="truncate">{selected ? selected.label : placeholder}</span>
          {selected?.description ? <span className="hidden truncate text-xs text-ink-subtle sm:inline">{selected.description}</span> : null}
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label={props["aria-label"] ?? placeholder} className="w-full min-w-64 p-0">
        <ComboboxPanel {...props} onPicked={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

function ComboboxPanel({
  options,
  value,
  onChange,
  searchPlaceholder = "Search…",
  emptyText = "No matches.",
  loading,
  clearLabel,
  footer,
  onPicked,
}: ComboboxProps & { onPicked: () => void }) {
  const { setOpen } = usePopover();
  const [query, setQuery] = React.useState("");
  const listId = React.useId();
  const rows = React.useMemo(() => {
    const filtered = options.filter((o) => matches(o, query.trim()));
    return clearLabel && !query.trim() ? [{ value: "", label: clearLabel } as ComboboxOption, ...filtered] : filtered;
  }, [options, query, clearLabel]);
  const initialIndex = Math.max(0, rows.findIndex((r) => r.value === (value ?? "")));
  const [active, setActive] = React.useState(initialIndex);
  const activeIndex = Math.min(active, Math.max(rows.length - 1, 0));
  const listRef = React.useRef<HTMLUListElement>(null);

  React.useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const pick = (row: ComboboxOption | undefined) => {
    if (!row || row.disabled) return;
    onChange(row.value === "" ? null : row.value);
    onPicked();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(Math.min(i, rows.length - 1) + 1, rows.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(Math.min(i, rows.length - 1) - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(rows.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(rows[activeIndex]);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <div className="flex max-h-[min(24rem,60dvh)] flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search aria-hidden="true" className="size-4 shrink-0 text-ink-subtle" />
        <input
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={rows.length > 0 ? optionId(activeIndex) : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={searchPlaceholder}
          className="h-10 w-full min-w-0 bg-transparent text-base text-ink outline-none placeholder:text-ink-subtle"
        />
        {loading ? <Spinner size="xs" /> : null}
      </div>
      <ul ref={listRef} id={listId} role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1 scrollbar-thin">
        {rows.length === 0 ? (
          <li role="presentation" className="px-2.5 py-6 text-center text-sm text-ink-muted">
            {loading ? "Loading…" : emptyText}
          </li>
        ) : (
          rows.map((row, i) => {
            const isSelected = (value ?? "") === row.value;
            return (
              <li
                key={row.value || "__none"}
                id={optionId(i)}
                data-index={i}
                role="option"
                aria-selected={isSelected}
                aria-disabled={row.disabled || undefined}
                onMouseMove={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(row)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-2 text-sm",
                  i === activeIndex ? "bg-surface-muted text-ink" : "text-ink-secondary",
                  row.disabled && "cursor-not-allowed opacity-50",
                  row.value === "" && "italic text-ink-muted",
                )}
              >
                {row.leading}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{row.label}</span>
                  {row.description ? <span className="truncate text-xs text-ink-subtle">{row.description}</span> : null}
                </span>
                {row.trailing}
                <Check aria-hidden="true" className={cn("size-4 shrink-0 text-accent", isSelected ? "opacity-100" : "opacity-0")} />
              </li>
            );
          })
        )}
      </ul>
      <ComboboxFooter footer={footer} query={query.trim()} close={() => setOpen(false)} />
    </div>
  );
}

/** Footer slot; renders nothing (no divider) when the footer has nothing to show for this query. */
function ComboboxFooter({ footer, query, close }: { footer: ComboboxProps["footer"]; query: string; close: () => void }) {
  if (!footer) return null;
  const node = footer(query, close);
  if (node === null || node === undefined || node === false) return null;
  return <div className="border-t border-border p-1">{node}</div>;
}
