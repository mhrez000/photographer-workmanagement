import * as React from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type SortDirection = "asc" | "desc" | null;

export interface TableProps extends React.ComponentPropsWithRef<"table"> {
  /** Row density. `compact` is the default for data-heavy lists. */
  density?: "compact" | "default" | "relaxed";
  /** Class for the scroll wrapper. */
  wrapperClassName?: string;
  /** Constrain height so the sticky header kicks in. */
  maxHeight?: string | number;
  /** Draw the outer hairline + rounded corners (off when inside a flush Card). */
  bordered?: boolean;
}

/**
 * Data table: 13px, tabular numerals, sticky header, hairline rows.
 * Wrap in `<Card flush>` for the standard list-page look.
 */
export function Table({
  className,
  wrapperClassName,
  density = "compact",
  maxHeight,
  bordered = false,
  ...props
}: TableProps) {
  return (
    <div
      data-density={density}
      className={cn(
        "relative w-full overflow-auto scrollbar-thin",
        bordered && "rounded-lg border border-border bg-surface shadow-xs",
        wrapperClassName,
      )}
      style={maxHeight !== undefined ? { maxHeight } : undefined}
    >
      <table
        className={cn("w-full caption-bottom border-collapse text-sm text-ink numeric", className)}
        {...props}
      />
    </div>
  );
}

export function THead({ className, ...props }: React.ComponentPropsWithRef<"thead">) {
  return (
    <thead
      className={cn(
        "sticky top-0 z-10 bg-surface-sunken text-left text-2xs font-semibold uppercase tracking-wider text-ink-muted",
        "[&_tr]:border-b [&_tr]:border-border",
        className,
      )}
      {...props}
    />
  );
}

export function TBody({ className, ...props }: React.ComponentPropsWithRef<"tbody">) {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

export function TFoot({ className, ...props }: React.ComponentPropsWithRef<"tfoot">) {
  return (
    <tfoot
      className={cn("border-t border-border bg-surface-sunken font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  );
}

export interface TRProps extends React.ComponentPropsWithRef<"tr"> {
  /** Highlighted (e.g. checked) row. */
  selected?: boolean;
  /** Entire row is clickable — adds pointer + stronger hover. */
  interactive?: boolean;
}

export function TR({ className, selected, interactive, ...props }: TRProps) {
  return (
    <tr
      data-state={selected ? "selected" : undefined}
      className={cn(
        "border-b border-border transition-colors duration-(--motion-fast)",
        "hover:bg-surface-muted/60 data-[state=selected]:bg-accent-soft/50",
        interactive && "cursor-pointer focus-within:bg-surface-muted/60",
        className,
      )}
      {...props}
    />
  );
}

export interface THProps extends React.ComponentPropsWithRef<"th"> {
  /** Right-align numeric columns. */
  numeric?: boolean;
  /** Enables the sort affordance. */
  sortable?: boolean;
  sortDirection?: SortDirection;
  onSort?: () => void;
  /** Collapse to content width. */
  shrink?: boolean;
}

export function TH({
  className,
  children,
  numeric,
  sortable,
  sortDirection = null,
  onSort,
  shrink,
  ...props
}: THProps) {
  const ariaSort = sortable
    ? sortDirection === "asc"
      ? "ascending"
      : sortDirection === "desc"
        ? "descending"
        : "none"
    : undefined;

  const SortIcon =
    sortDirection === "asc" ? ArrowUp : sortDirection === "desc" ? ArrowDown : ChevronsUpDown;

  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className={cn(
        "h-9 whitespace-nowrap px-3 align-middle font-semibold first:pl-4 last:pr-4",
        "in-data-[density=relaxed]:h-11 in-data-[density=default]:h-10",
        numeric && "text-right",
        shrink && "w-px",
        sortable && "p-0 first:pl-1 last:pr-1",
        className,
      )}
      {...props}
    >
      {sortable ? (
        <button
          type="button"
          onClick={onSort}
          className={cn(
            "group/sort inline-flex h-full w-full items-center gap-1 rounded-xs px-3 py-2 text-left uppercase tracking-wider",
            "hover:text-ink focus-ring-inset",
            numeric && "flex-row-reverse text-right",
            sortDirection && "text-ink",
          )}
        >
          <span>{children}</span>
          <SortIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-ink-subtle transition-opacity",
              sortDirection ? "text-accent-ink" : "opacity-50 group-hover/sort:opacity-100",
            )}
          />
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export interface TDProps extends React.ComponentPropsWithRef<"td"> {
  numeric?: boolean;
  /** Muted secondary text. */
  muted?: boolean;
  /** Truncate long content with ellipsis (set a width/max-width). */
  truncate?: boolean;
  /** Primary cell: medium weight, full ink. */
  primary?: boolean;
}

export function TD({ className, numeric, muted, truncate, primary, ...props }: TDProps) {
  return (
    <td
      className={cn(
        "px-3 py-2 align-middle first:pl-4 last:pr-4",
        "in-data-[density=default]:py-2.5 in-data-[density=relaxed]:py-3.5",
        numeric && "text-right",
        muted && "text-ink-muted",
        truncate && "max-w-0 truncate",
        primary && "font-medium text-ink",
        className,
      )}
      {...props}
    />
  );
}

export function TableCaption({ className, ...props }: React.ComponentPropsWithRef<"caption">) {
  return <caption className={cn("mt-3 text-sm text-ink-muted", className)} {...props} />;
}

/** Full-width placeholder row (empty / loading states inside the table). */
export function TableEmptyRow({
  colSpan,
  className,
  children,
  ...props
}: React.ComponentPropsWithRef<"td"> & { colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className={cn("px-4 py-10 text-center text-ink-muted", className)} {...props}>
        {children}
      </td>
    </tr>
  );
}
